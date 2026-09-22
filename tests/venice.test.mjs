// venice.test.mjs — suite de tests (node:test, zéro framework externe).
//
// Couvre :
//   1. le parseur SSE et l'extraction des deltas (schémas amont tolérants) ;
//   2. la validation des payloads et les trois modes de message système ;
//   3. les cookies (sérialisation, injection manuelle) ;
//   4. la session Cloudflare (mutex, reprise après challenge, tolérance) ;
//   5. l'intégration HTTP complète contre un faux chat.dphn.ai :
//      catalogue, streaming, rejeu après challenge, rate limit, mode démo.

import test from "node:test";
import assert from "node:assert/strict";

import { parseEvent, parseSSE, extractDelta, isDone, sseFrame } from "../lib/sse.js";
import { validateChatPayload, buildUpstreamMessages, ValidationError } from "../lib/messages.js";
import { DolphinSession, parseCookieHeader } from "../lib/session.js";
import { cookiesToHeader, relevantCookies } from "../lib/cloudflare.js";
import { getConfig } from "../lib/config.js";
import { createRuntime } from "../lib/runtime.js";
import { createApp } from "../server.js";
import { createMockDolphin } from "./mock-dolphin.mjs";

const silentLog = { log() {}, warn() {}, error() {} };

/** Flux binaire à partir de morceaux de texte (comme un vrai stream HTTP). */
function streamOf(...chunks) {
  return new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

/* ========================================================================== */
/* 1. SSE                                                                     */
/* ========================================================================== */

test("parseEvent lit data / event / id et ignore les commentaires", () => {
  assert.deepEqual(parseEvent("data: hello"), { event: "message", data: "hello", id: null, raw: "data: hello" });
  assert.deepEqual(parseEvent(": heartbeat")?.data, undefined);
  const event = parseEvent("event: ping\nid: 42\ndata: {\"a\":1}\ndata: suite");
  assert.equal(event.event, "ping");
  assert.equal(event.id, "42");
  assert.equal(event.data, '{"a":1}\nsuite');
});

test("parseSSE reconstruit les trames coupées en plein milieu", async () => {
  const events = await collect(
    parseSSE(streamOf('data: {"choices":[{"delta":{"cont', 'ent":"Bon"}}]}\n\n', "data: [DONE]\n\n"))
  );
  assert.equal(events.length, 2);
  assert.equal(extractDelta(JSON.parse(events[0].data)), "Bon");
  assert.ok(isDone(events[1].data));
});

test("extractDelta reconnaît les schémas OpenAI, texte et Ollama", () => {
  assert.equal(extractDelta({ choices: [{ delta: { content: "a" } }] }), "a");
  assert.equal(extractDelta({ choices: [{ message: { content: "b" } }] }), "b");
  assert.equal(extractDelta({ choices: [{ text: "c" }] }), "c");
  assert.equal(extractDelta({ delta: "d" }), "d");
  assert.equal(extractDelta({ token: "e" }), "e");
  assert.equal(extractDelta({ response: "f" }), "f");
  assert.equal(extractDelta({ message: { content: "g" } }), "g");
  assert.equal(extractDelta({ choices: [{ delta: { role: "assistant" } }] }), null);
  assert.equal(extractDelta({ usage: { total_tokens: 3 } }), null);
  assert.equal(extractDelta("brut"), "brut");
});

test("sseFrame produit une trame valide", () => {
  assert.equal(sseFrame({ delta: "ok" }), 'data: {"delta":"ok"}\n\n');
});

/* ========================================================================== */
/* 2. Validation et message système                                           */
/* ========================================================================== */

test("validateChatPayload assainit et applique les défauts", () => {
  const payload = validateChatPayload(
    { messages: [{ role: "user", content: "Salut" }] },
    { models: ["dolphinserver:24B"], templates: ["logical"] }
  );
  assert.equal(payload.model, "dolphinserver:24B");
  assert.equal(payload.template, "logical");
  assert.equal(payload.stream, true);
});

test("validateChatPayload refuse les entrées invalides", () => {
  const cases = [
    [{ messages: [] }, /non vide/],
    [{ messages: [{ role: "system", content: "x" }] }, /rôle invalide/],
    [{ messages: [{ role: "user", content: "   " }] }, /contenu vide/],
    [{ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "b" }] }, /dernier message/],
    [{ messages: [{ role: "user", content: "a" }], model: "pas un id !" }, /model.*invalide/],
    [{ messages: [{ role: "user", content: "a" }], model: "inconnu:1B" }, /inconnu/],
    [{ messages: [{ role: "user", content: "a" }], template: "root" }, /template.*inconnu/],
    [{ messages: [{ role: "user", content: "a" }], instructions: 42 }, /instructions/],
  ];
  for (const [body, pattern] of cases) {
    assert.throws(
      () => validateChatPayload(body, { models: ["dolphinserver:24B"], templates: ["logical"] }),
      (error) => error instanceof ValidationError && pattern.test(error.message),
      `attendu refus pour ${JSON.stringify(body)}`
    );
  }
});

test("buildUpstreamMessages : system, message et none", () => {
  const messages = [{ role: "assistant", content: "précédent" }, { role: "user", content: "question" }];

  const withSystem = buildUpstreamMessages({ messages, systemPrompt: "PROMPT", mode: "system" });
  assert.deepEqual(withSystem[0], { role: "system", content: "PROMPT" });
  assert.equal(withSystem.length, 3);

  const merged = buildUpstreamMessages({ messages, systemPrompt: "PROMPT", mode: "message" });
  assert.equal(merged.length, 2);
  assert.ok(merged[1].content.startsWith("[CONSIGNES SYSTÈME"));
  assert.ok(merged[1].content.endsWith("question"));
  assert.equal(merged[0].content, "précédent");

  const bare = buildUpstreamMessages({ messages, systemPrompt: "PROMPT", mode: "none" });
  assert.deepEqual(bare, messages);

  const withInstructions = buildUpstreamMessages({
    messages,
    systemPrompt: "PROMPT",
    instructions: "réponds en anglais",
    mode: "system",
  });
  assert.match(withInstructions[0].content, /réponds en anglais/);
});

/* ========================================================================== */
/* 3. Cookies                                                                 */
/* ========================================================================== */

test("cookiesToHeader et relevantCookies", () => {
  const cookies = [
    { name: "cf_clearance", value: "abc" },
    { name: "__cf_ob", value: "xyz" },
    { name: "autre", value: "1" },
  ];
  assert.equal(cookiesToHeader(cookies), "cf_clearance=abc; __cf_ob=xyz; autre=1");
  assert.equal(relevantCookies(cookies).length, 2);
  assert.equal(cookiesToHeader([{ name: "a" }, null, { name: "b", value: "2" }]), "b=2");
});

test("parseCookieHeader reconstruit un cookie manuel", () => {
  const cookies = parseCookieHeader("cf_clearance=abc; __cf_ob=def=");
  assert.equal(cookies.length, 2);
  assert.equal(cookies[0].name, "cf_clearance");
  assert.equal(cookies[0].domain, "chat.dphn.ai");
  assert.equal(cookies[1].value, "def=");
});

/* ========================================================================== */
/* 4. Session Cloudflare                                                      */
/* ========================================================================== */

function testConfig(overrides = {}) {
  return getConfig({
    DOLPHIN_BASE_URL: "http://127.0.0.1:1",
    DOLPHIN_SOLVER: "playwright",
    VENICE_RATE_LIMIT: "0",
    ...overrides,
  });
}

function fakeSolver(cookie = "cf_clearance=good") {
  let calls = 0;
  const solver = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {
      cookieHeader: cookie,
      cookies: parseCookieHeader(cookie),
      verified: true,
      obtainedAt: Date.now(),
    };
  };
  solver.calls = () => calls;
  return solver;
}

test("la session mutualise les rafraîchissements concurrents", async () => {
  const solver = fakeSolver();
  const session = new DolphinSession(testConfig(), { solver, log: silentLog });
  const [a, b, c] = await Promise.all([session.ensureFresh(), session.ensureFresh(), session.ensureFresh()]);
  assert.equal(a, "cf_clearance=good");
  assert.equal(b, a);
  assert.equal(c, a);
  assert.equal(solver.calls(), 1, "un seul navigateur lancé pour trois demandes");
  assert.equal(session.status().state, "warm");
  assert.equal(session.status().refreshes, 1);
});

test("la session ne relance pas le solveur tant que le cookie est frais", async () => {
  const solver = fakeSolver();
  const session = new DolphinSession(testConfig(), { solver, log: silentLog });
  await session.ensureFresh();
  await session.ensureFresh();
  assert.equal(solver.calls(), 1);
  await session.ensureFresh({ force: true, reason: "test" });
  assert.equal(solver.calls(), 2);
});

test("un cookie manuel suffit quand le solveur est désactivé", async () => {
  const cfg = testConfig({ DOLPHIN_SOLVER: "none", DOLPHIN_COOKIE: "cf_clearance=manual; __cf_ob=x" });
  const session = new DolphinSession(cfg, { log: silentLog });
  assert.equal(session.source, "manual");
  assert.equal(await session.ensureFresh(), "cf_clearance=manual; __cf_ob=x");

  const emptyCfg = testConfig({ DOLPHIN_SOLVER: "none" });
  const empty = new DolphinSession(emptyCfg, { log: silentLog });
  await assert.rejects(() => empty.ensureFresh(), /DOLPHIN_COOKIE/);
});

test("un échec du solveur n'efface pas un cookie encore présent", async () => {
  const cfg = testConfig({ DOLPHIN_COOKIE: "cf_clearance=vieux" });
  const session = new DolphinSession(cfg, {
    solver: async () => {
      throw new Error("Cloudflare a dit non");
    },
    log: silentLog,
  });
  const cookie = await session.ensureFresh({ force: true, reason: "test" });
  assert.equal(cookie, "cf_clearance=vieux");
  assert.equal(session.status().failures, 1);
  assert.match(session.status().lastError, /Cloudflare a dit non/);
});

test("recover force un nouveau cookie après un challenge", async () => {
  const solver = fakeSolver("cf_clearance=neuf");
  const session = new DolphinSession(testConfig({ DOLPHIN_COOKIE: "cf_clearance=perime" }), {
    solver,
    log: silentLog,
  });
  const cookie = await session.recover("POST /api/chat");
  assert.equal(cookie, "cf_clearance=neuf");
  assert.equal(session.status().source, "playwright");
});

/* ========================================================================== */
/* 5. Intégration HTTP                                                        */
/* ========================================================================== */

async function startMockRuntime({ mockOptions = {}, env = {}, session: givenSession } = {}) {
  const mock = createMockDolphin(mockOptions);
  const baseUrl = await mock.listen(0);

  const cfg = testConfig({ DOLPHIN_BASE_URL: baseUrl, ...env });
  const solver = fakeSolver("cf_clearance=good; __cf_ob=ok");
  const session =
    givenSession ??
    new DolphinSession(cfg, {
      solver,
      log: silentLog,
    });

  const runtime = createRuntime(env, { cfg, session, solver, log: silentLog });
  const server = createApp(env, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    mock,
    cfg,
    runtime,
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await mock.close();
    },
  };
}

test("GET /api/catalog renvoie les modèles et rôles de l'amont", async () => {
  const ctx = await startMockRuntime();
  try {
    const res = await fetch(`${ctx.base}/api/catalog`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.source, "live");
    assert.equal(data.models.length, 2);
    assert.equal(data.models[0].id, "dolphinserver:24B");
    assert.equal(data.models[0].label, "Dolphin 24B");
    assert.equal(data.templates.length, 5);
    assert.equal(data.templates[0].id, "logical");
    assert.equal(data.templates[0].label, "Logique");
    assert.equal(data.defaultModel, "dolphinserver:24B");
  } finally {
    await ctx.close();
  }
});

test("POST /api/chat re-streame le SSE amont au format Venice", async () => {
  const ctx = await startMockRuntime();
  try {
    const res = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Bonjour" }],
        model: "dolphinserver:24B",
        template: "logical",
      }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);

    const text = await res.text();
    assert.match(text, /"status":"started"/);
    assert.match(text, /data: \[DONE\]/);

    const deltas = text
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((payload) => payload && payload !== "[DONE]")
      .map((payload) => JSON.parse(payload))
      .filter((obj) => typeof obj.delta === "string")
      .map((obj) => obj.delta)
      .join("");

    assert.match(deltas, /Réponse simulée/);
    assert.match(deltas, /dolphinserver:24B/);
    assert.match(deltas, /```js/);
    assert.ok(ctx.mock.state.requests.some((r) => r.path === "/api/chat"));
    assert.match(ctx.mock.state.requests.at(-1).cookie, /cf_clearance=good/);
  } finally {
    await ctx.close();
  }
});

test("un challenge Cloudflare déclenche un rafraîchissement puis un rejeu", async () => {
  const cfg = testConfig({ DOLPHIN_BASE_URL: "http://127.0.0.1:1", DOLPHIN_COOKIE: "cf_clearance=perime" });
  const solver = fakeSolver("cf_clearance=good");
  const session = new DolphinSession(cfg, { solver, log: silentLog });

  const mock = createMockDolphin();
  const baseUrl = await mock.listen(0);
  const liveCfg = { ...cfg, baseUrl };
  const runtime = createRuntime({}, { cfg: liveCfg, session, solver, log: silentLog });
  const server = createApp({}, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const res = await fetch(`${base}/api/models`);
    const data = await res.json();
    assert.equal(res.status, 200);
    assert.equal(data.data.length, 2);
    assert.ok(mock.state.challenged >= 1, "le mock a bien opposé un challenge");
    assert.equal(solver.calls(), 1, "le cookie a été renouvelé une fois");
    assert.match(session.cookieHeader, /cf_clearance=good/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await mock.close();
  }
});

test("le mode système se négocie automatiquement si l'amont refuse role=system", async () => {
  const ctx = await startMockRuntime({ mockOptions: { strictSystem: true } });
  try {
    const res = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Qui es-tu ?" }],
        model: "dolphinserver:24B",
        template: "logical",
      }),
    });
    const text = await res.text();
    const deltas = text
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((payload) => payload && payload !== "[DONE]")
      .map((payload) => JSON.parse(payload))
      .filter((obj) => typeof obj.delta === "string")
      .map((obj) => obj.delta)
      .join("");
    assert.match(deltas, /Réponse simulée/);
    assert.match(deltas, /avec consigne système/, "les consignes ont survécu à la dégradation");

    // Deux requêtes : la première avec role=system (refusée), la seconde dégradée.
    const bodies = ctx.mock.state.bodies;
    assert.equal(bodies.length, 2, "un refus puis un succès");
    assert.equal(bodies[0].messages[0].role, "system");
    assert.equal(bodies[1].messages[0].role, "user");
    assert.match(bodies[1].messages.at(-1).content, /\[CONSIGNES SYSTÈME/);
  } finally {
    await ctx.close();
  }
});

test("le catalogue de secours prend le relais si l'amont est injoignable", async () => {
  const cfg = testConfig({ DOLPHIN_BASE_URL: "http://127.0.0.1:9" }); // port fermé
  const session = new DolphinSession(cfg, { solver: fakeSolver(), log: silentLog });
  const runtime = createRuntime({}, { cfg, session, log: silentLog });
  const server = createApp({}, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const data = await (await fetch(`${base}/api/models`)).json();
    assert.equal(data.source, "fallback");
    assert.equal(data.data.length, 2);
    assert.ok(data.warning, "l'avertissement est transmis à l'interface");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("le rate limit protège l'amont", async () => {
  const ctx = await startMockRuntime({ env: { VENICE_RATE_LIMIT: "1" } });
  try {
    const body = JSON.stringify({ messages: [{ role: "user", content: "salut" }] });
    const first = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    await first.text();
    const second = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    assert.equal(second.status, 429);
    const payload = await second.json();
    assert.equal(payload.error.code, "RATE_LIMITED");
    assert.ok(second.headers.get("retry-after"));
  } finally {
    await ctx.close();
  }
});

test("le mode démo répond sans toucher à l'amont", async () => {
  const ctx = await startMockRuntime({ env: { DEMO_MODE: "1" } });
  try {
    // Le catalogue lui-même ne doit pas déclencher d'appel amont en démo.
    const catalog = await (await fetch(`${ctx.base}/api/catalog`)).json();
    assert.equal(catalog.source, "fallback");

    const res = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "Qui es-tu ?" }] }),
    });
    const text = await res.text();
    assert.match(text, /"demo":true/);
    const deltas = text
      .split("\n\n")
      .map((chunk) => chunk.replace(/^data: /, ""))
      .filter((payload) => payload && payload !== "[DONE]")
      .map((payload) => JSON.parse(payload))
      .filter((obj) => typeof obj.delta === "string")
      .map((obj) => obj.delta)
      .join("");
    assert.match(deltas, /Venice/);
    assert.equal(ctx.mock.state.requests.length, 0, "aucun appel amont en mode démo");

    const health = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(health.demoMode, true);
  } finally {
    await ctx.close();
  }
});

test("GET /api/health décrit la passerelle sans fuiter de secret", async () => {
  const ctx = await startMockRuntime();
  try {
    const health = await (await fetch(`${ctx.base}/api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.name, "Venice");
    assert.equal(health.author, "Crazy Prince");
    assert.ok(health.session.state);
    assert.equal(health.upstream.baseUrl, ctx.cfg.baseUrl);
    const serialized = JSON.stringify(health);
    assert.doesNotMatch(serialized, /cf_clearance=[^"]/, "le cookie n'apparaît jamais en clair");
  } finally {
    await ctx.close();
  }
});

test("POST /api/session/refresh est refusé sans ADMIN_TOKEN", async () => {
  const ctx = await startMockRuntime();
  try {
    const res = await fetch(`${ctx.base}/api/session/refresh`, { method: "POST" });
    assert.equal(res.status, 403);
  } finally {
    await ctx.close();
  }
});

test("les entrées invalides reçoivent une erreur 400 explicite", async () => {
  const ctx = await startMockRuntime();
  try {
    const res = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "ok" }, { role: "assistant", content: "faux" }] }),
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(payload.error.message, /dernier message/);
  } finally {
    await ctx.close();
  }
});

test("les fichiers statiques sont servis et la traversée est bloquée", async () => {
  const ctx = await startMockRuntime();
  try {
    const index = await fetch(`${ctx.base}/`);
    assert.equal(index.status, 200);
    const html = await index.text();
    assert.match(html, /Venice/);
    assert.match(html, /historyDrawer/);

    const css = await fetch(`${ctx.base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /text\/css/);

    const traversal = await fetch(`${ctx.base}/..%2fpackage.json`);
    assert.notEqual(traversal.status, 200);
  } finally {
    await ctx.close();
  }
});
