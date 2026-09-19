// httpApi.js — couche HTTP de Venice (routes /api/*).
//
// Contrat public (identique sur Render, Docker et en local) :
//
//   POST /api/chat              → SSE `data:{"delta":…}` … `data:[DONE]`
//                                 (ou JSON `{reply}` si `"stream":false`)
//   GET  /api/models            → catalogue des modèles Dolphin
//   GET  /api/templates         → catalogue des rôles (templates) Dolphin
//   GET  /api/catalog           → les deux d'un coup + métadonnées de cache
//   GET  /api/health            → état de la passerelle et de la session CF
//   POST /api/session/refresh   → force un cookie neuf (réservé : ADMIN_TOKEN)

import { APP_NAME, APP_AUTHOR, APP_VERSION } from "./config.js";
import { ValidationError, validateChatPayload } from "./messages.js";
import { DolphinError, completeChat, streamChat } from "./dolphin.js";
import { catalogIds } from "./catalog.js";
import { clientKey } from "./ratelimit.js";
import { demoStream, demoTextFrom } from "./demo.js";
import { SSE_HEADERS, sseFrame } from "./sse.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/* -------------------------------------------------------------------------- */
/* Helpers de réponse                                                         */
/* -------------------------------------------------------------------------- */

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...JSON_HEADERS, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

export function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const payload = {
    error: {
      status,
      message: error?.message || "Erreur interne de la passerelle.",
      ...(error?.code ? { code: error.code } : {}),
      ...(error?.detail ? { detail: error.detail } : {}),
    },
  };
  if (res.headersSent) {
    // Flux déjà ouvert : on signale l'erreur dans le SSE puis on ferme.
    res.write(sseFrame(payload));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }
  sendJson(res, status, payload);
}

/** Lit un corps JSON (limite 1 Mo). */
export async function readJsonBody(req, limit = 1_048_576) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError("Requête trop volumineuse (max 1 Mo).");
    chunks.push(chunk);
  }
  if (!chunks.length) throw new ValidationError("Corps de requête vide.");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ValidationError("JSON invalide dans le corps de la requête.");
  }
}

function rateLimit(res, runtime, req, cost = 1) {
  const { limiter, cfg } = runtime;
  if (!limiter.enabled) return true;
  const key = clientKey(req, { trustProxy: cfg.trustProxy });
  const result = limiter.check(key);
  res.setHeader("X-RateLimit-Limit", String(cfg.rateLimit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, result.remaining)));
  if (!result.ok) {
    res.setHeader("Retry-After", String(result.retryAfterSec));
    sendJson(res, 429, {
      error: {
        status: 429,
        code: "RATE_LIMITED",
        message: `Trop de requêtes. Réessayez dans ${result.retryAfterSec} s.`,
      },
    });
    return false;
  }
  return true;
}

/* -------------------------------------------------------------------------- */
/* POST /api/chat                                                             */
/* -------------------------------------------------------------------------- */

export async function handleChatHttp(req, res, runtime) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, {
      error: { status: 405, message: "Méthode non autorisée : utilisez POST." },
    });
    return;
  }
  const { cfg, session, catalog } = runtime;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendError(res, error);
    return;
  }

  // Le catalogue sert d'allowlist : impossible d'appeler un modèle hors liste.
  const known = catalogIds(catalog.peek());
  let payload;
  try {
    payload = validateChatPayload(body, { ...known, limits: cfg.limits });
  } catch (error) {
    sendError(res, error);
    return;
  }

  if (!rateLimit(res, runtime, req)) return;

  const wantsStream = payload.stream && new URL(req.url, "http://localhost").searchParams.get("stream") !== "0";

  /* ----------------------------- Mode démo ------------------------------ */
  if (cfg.demoMode) {
    const lastUser = payload.messages[payload.messages.length - 1].content;
    if (!wantsStream) {
      sendJson(res, 200, {
        reply: demoTextFrom(lastUser),
        model: payload.model,
        template: payload.template,
        demo: true,
      });
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(sseFrame({ status: "started", demo: true, model: payload.model, template: payload.template }));
    for await (const delta of demoStream(lastUser)) res.write(sseFrame({ delta }));
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  /* --------------------------- Mode réel -------------------------------- */
  if (!wantsStream) {
    try {
      const reply = await completeChat({
        cfg,
        session,
        payload: { ...payload, systemPrompt: cfg.systemPrompt },
        log: console,
      });
      sendJson(res, 200, {
        reply,
        model: payload.model,
        template: payload.template,
        demo: false,
      });
    } catch (error) {
      sendError(res, mapError(error));
    }
    return;
  }

  // Streaming : on ouvre le flux tout de suite, puis on relaie les tokens.
  res.writeHead(200, SSE_HEADERS);
  res.write(
    sseFrame({
      status: "started",
      model: payload.model,
      template: payload.template,
      author: APP_AUTHOR,
    })
  );

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    for await (const delta of streamChat({
      cfg,
      session,
      payload: { ...payload, systemPrompt: cfg.systemPrompt },
      signal: controller.signal,
      log: console,
    })) {
      if (res.writableEnded) break;
      res.write(sseFrame({ delta }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    sendError(res, mapError(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Catalogues                                                                 */
/* -------------------------------------------------------------------------- */

export async function handleCatalogHttp(req, res, runtime, kind) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée : utilisez GET." } });
    return;
  }
  const force = new URL(req.url, "http://localhost").searchParams.get("refresh") === "1";
  const catalog = await runtime.catalog.get({ force });

  if (kind === "models") {
    sendJson(res, 200, {
      data: catalog.models,
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ...(catalog.error ? { warning: catalog.error } : {}),
    });
    return;
  }
  if (kind === "templates") {
    sendJson(res, 200, {
      data: catalog.templates,
      source: catalog.source,
      fetchedAt: catalog.fetchedAt,
      ...(catalog.error ? { warning: catalog.error } : {}),
    });
    return;
  }
  sendJson(res, 200, {
    models: catalog.models,
    templates: catalog.templates,
    defaultModel: catalog.defaultModel,
    defaultTemplate: catalog.defaultTemplate,
    source: catalog.source,
    fetchedAt: catalog.fetchedAt,
    ...(catalog.error ? { warning: catalog.error } : {}),
  });
}

/* -------------------------------------------------------------------------- */
/* Santé                                                                      */
/* -------------------------------------------------------------------------- */

export function handleHealthHttp(_req, res, runtime, extra = {}) {
  const { cfg, session, catalog, startedAt } = runtime;
  const cat = catalog.status();

  sendJson(res, 200, {
    ok: true,
    name: APP_NAME,
    author: APP_AUTHOR,
    version: APP_VERSION,
    demoMode: cfg.demoMode,
    uptimeMs: Date.now() - startedAt,
    upstream: {
      baseUrl: cfg.baseUrl,
      routes: ["/api/models", "/api/templates", "/api/chat"],
      systemMode: cfg.systemMode,
    },
    session: session.status(),
    catalog: cat,
    history: cfg.history,
    artifacts: extra,
  });
}

/* -------------------------------------------------------------------------- */
/* Rafraîchissement manuel de session                                         */
/* -------------------------------------------------------------------------- */

export async function handleSessionRefresh(req, res, runtime) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée : utilisez POST." } });
    return;
  }
  const { cfg, session } = runtime;
  if (!cfg.adminToken) {
    sendJson(res, 403, {
      error: {
        status: 403,
        message: "Action réservée : définissez ADMIN_TOKEN pour l'autoriser.",
      },
    });
    return;
  }
  if (req.headers["x-admin-token"] !== cfg.adminToken) {
    sendJson(res, 401, { error: { status: 401, message: "Jeton administrateur invalide." } });
    return;
  }

  try {
    await session.ensureFresh({ force: true, reason: "manual" });
    sendJson(res, 200, { ok: true, session: session.status() });
  } catch (error) {
    sendError(res, mapError(error));
  }
}

/* -------------------------------------------------------------------------- */
/* Mapping d'erreurs                                                          */
/* -------------------------------------------------------------------------- */

export function mapError(error) {
  if (error instanceof ValidationError) return error;
  if (error instanceof DolphinError) return error;

  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") {
    return new DolphinError(499, "Génération interrompue.");
  }
  if (error?.code === "SOLVER_UNAVAILABLE") {
    return new DolphinError(503, error.message, { code: "SOLVER_UNAVAILABLE", detail: error.detail });
  }
  if (error?.code === "SOLVER_FAILED") {
    return new DolphinError(503, error.message, { code: "SOLVER_FAILED", detail: error.detail });
  }
  if (error?.code === "ENOTFOUND" || error?.code === "ECONNREFUSED" || error?.cause?.code) {
    return new DolphinError(503, "Impossible de joindre le chat Dolphin depuis le serveur.", {
      code: "UPSTREAM_UNREACHABLE",
      detail: error.message,
    });
  }
  if (error?.name === "TimeoutError" || error?.code === "UND_ERR_CONNECT_TIMEOUT") {
    return new DolphinError(504, "Dolphin n'a pas répondu à temps.", { code: "TIMEOUT" });
  }
  return new DolphinError(500, error?.message || "Erreur interne de la passerelle.", {
    code: "INTERNAL",
  });
}
