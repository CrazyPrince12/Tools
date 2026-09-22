// tests/history.test.mjs — Historique utilisateur persisté en base de données.
//
// Vérifie le correctif « je me déconnecte / reconnecte et je retrouve mon
// historique » :
//   • les messages de chat sont rattachés à leur conversation en base ;
//   • GET /api/history les restitue après logout → login ;
//   • renommages et instructions sont persistés ;
//   • la suppression demandée par l'utilisateur est LOGIQUE : comme dans le
//     panneau admin, les messages ne sont JAMAIS détruits ;
//   • les anciens messages sans conversation_id sont regroupés dans une
//     conversation « Anciens messages ».

import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server.js";
import { createRuntime } from "../lib/runtime.js";
import { initDb } from "../lib/db.js";

const silentLog = { log() {}, warn() {}, error() {} };

async function startTestServer() {
  await initDb();
  const runtime = createRuntime({ DEMO_MODE: "1" }, { log: silentLog });
  const server = createApp({ DEMO_MODE: "1" }, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function registerUser(base, username) {
  const res = await fetch(`${base}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pseudo: "Test Histoire",
      username,
      email: `${username}@example.com`,
      heard_from: "Tests",
      password: "password123",
    }),
  });
  assert.equal(res.status, 201);
  const data = await res.json();
  return { token: data.token, userId: data.user.id };
}

async function chat(base, token, { conversationId, content }) {
  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      ...(conversationId ? { conversationId } : {}),
      messages: [{ role: "user", content }],
      model: "dolphinserver:24B",
      template: "logical",
      stream: false,
    }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

async function getHistory(base, token) {
  const res = await fetch(`${base}/api/history`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(res.status, 200);
  return res.json();
}

test("Historique : retrouvé intact après déconnexion puis reconnexion", async () => {
  const ctx = await startTestServer();
  const username = `hist_${Date.now()}`;
  const conversationId = `c${Date.now().toString(36)}test1`;

  try {
    let { token, userId } = await registerUser(ctx.base, username);

    // 1. Discussion enregistrée en base avec son identifiant de conversation.
    const reply = await chat(ctx.base, token, {
      conversationId,
      content: "Bonjour Venice, te souviendras-tu de moi ?",
    });
    assert.ok(reply.reply);

    // 2. L'historique est immédiatement disponible côté serveur.
    const hist = await getHistory(ctx.base, token);
    assert.equal(hist.conversations.length, 1);
    const conv = hist.conversations[0];
    assert.equal(conv.id, conversationId);
    assert.equal(conv.messages.length, 2);
    assert.equal(conv.messages[0].role, "user");
    assert.equal(conv.messages[0].content, "Bonjour Venice, te souviendras-tu de moi ?");
    assert.equal(conv.messages[1].role, "assistant");
    assert.ok(conv.title.includes("Bonjour Venice"));
    assert.ok(Number.isFinite(conv.createdAt) && Number.isFinite(conv.updatedAt));
    assert.ok(conv.messages.every((m) => Number.isFinite(m.ts)));

    // 3. Déconnexion (le jeton est révoqué, comme dans le navigateur).
    const outRes = await fetch(`${ctx.base}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(outRes.status, 200);

    const denied = await fetch(`${ctx.base}/api/history`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(denied.status, 401);

    // 4. Reconnexion → l'historique revient de la base de données.
    const loginRes = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: username, password: "password123" }),
    });
    assert.equal(loginRes.status, 200);
    token = (await loginRes.json()).token;

    const hist2 = await getHistory(ctx.base, token);
    assert.equal(hist2.conversations.length, 1);
    assert.equal(hist2.conversations[0].id, conversationId);
    assert.equal(hist2.conversations[0].messages.length, 2);
    assert.equal(
      hist2.conversations[0].messages[0].content,
      "Bonjour Venice, te souviendras-tu de moi ?"
    );

    // 5. Renommage + instructions persistés via POST /api/history/conversation.
    const metaRes = await fetch(`${ctx.base}/api/history/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: conversationId,
        title: "Ma discussion renommée",
        instructions: "Sois bref.",
        updatedAt: Date.now(),
      }),
    });
    assert.equal(metaRes.status, 200);

    const hist3 = await getHistory(ctx.base, token);
    assert.equal(hist3.conversations[0].title, "Ma discussion renommée");
    assert.equal(hist3.conversations[0].instructions, "Sois bref.");

    // 6. Un nouveau message ne doit PAS écraser le renommage utilisateur.
    await chat(ctx.base, token, { conversationId, content: "Et maintenant ?" });
    const hist4 = await getHistory(ctx.base, token);
    assert.equal(hist4.conversations[0].title, "Ma discussion renommée");
    assert.equal(hist4.conversations[0].messages.length, 4);

    // 7. Suppression par l'utilisateur → LOGIQUE : disparue de son historique…
    const delRes = await fetch(
      `${ctx.base}/api/history/conversation/${encodeURIComponent(conversationId)}`,
      { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }
    );
    assert.equal(delRes.status, 200);
    const hist5 = await getHistory(ctx.base, token);
    assert.equal(hist5.conversations.length, 0);

    // …mais l'admin conserve TOUT (les messages ne sont jamais détruits).
    const adminLogin = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "CrazyPrince", password: "CRAZY237" }),
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = (await adminLogin.json()).token;

    const adminMsgRes = await fetch(`${ctx.base}/api/admin/users/${userId}/messages`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminMsgRes.status, 200);
    const adminMsgs = await adminMsgRes.json();
    const saved = adminMsgs.filter((m) => m.conversation_id === conversationId);
    assert.equal(saved.length, 4); // 2 exchanges user + assistant, jamais supprimés
  } finally {
    await ctx.close();
  }
});

test("Historique : « Tout effacer » est logique, l'admin garde les messages", async () => {
  const ctx = await startTestServer();
  const username = `wipe_${Date.now()}`;

  try {
    const { token, userId } = await registerUser(ctx.base, username);
    await chat(ctx.base, token, { conversationId: `c${Date.now().toString(36)}w1`, content: "Un" });
    await chat(ctx.base, token, { conversationId: `c${Date.now().toString(36)}w2`, content: "Deux" });

    const before = await getHistory(ctx.base, token);
    assert.equal(before.conversations.length, 2);

    const delAll = await fetch(`${ctx.base}/api/history`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(delAll.status, 200);
    assert.equal((await delAll.json()).hidden, 2);

    const after = await getHistory(ctx.base, token);
    assert.equal(after.conversations.length, 0);

    // Admin : les messages existent toujours.
    const adminLogin = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: "CrazyPrince", password: "CRAZY237" }),
    });
    const adminToken = (await adminLogin.json()).token;
    const adminMsgs = await (
      await fetch(`${ctx.base}/api/admin/users/${userId}/messages`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      })
    ).json();
    assert.equal(adminMsgs.length, 4);
  } finally {
    await ctx.close();
  }
});

test("Historique : les anciens messages sans conversation sont regroupés (« Anciens messages »)", async () => {
  const ctx = await startTestServer();
  const username = `legacy_${Date.now()}`;

  try {
    const { token } = await registerUser(ctx.base, username);

    // Message enregistré SANS conversationId (cas des historiques antérieurs
    // au correctif de persistance).
    await chat(ctx.base, token, { content: "Vieux message sans conversation." });

    const hist = await getHistory(ctx.base, token);
    assert.equal(hist.conversations.length, 1);
    const legacy = hist.conversations[0];
    assert.match(legacy.id, /^legacy-/);
    assert.equal(legacy.title, "Anciens messages");
    assert.equal(legacy.messages.length, 2);
    assert.equal(legacy.messages[0].content, "Vieux message sans conversation.");
  } finally {
    await ctx.close();
  }
});

test("Historique : inaccessible sans authentification", async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.base}/api/history`);
    assert.equal(res.status, 401);

    const upsertRes = await fetch(`${ctx.base}/api/history/conversation`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "cx1" }),
    });
    assert.equal(upsertRes.status, 401);

    const delRes = await fetch(`${ctx.base}/api/history/conversation/cx1`, {
      method: "DELETE",
    });
    assert.equal(delRes.status, 401);
  } finally {
    await ctx.close();
  }
});
