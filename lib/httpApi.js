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
//   Routes Auth & Admin         → /api/auth/* et /api/admin/*

import { APP_NAME, APP_AUTHOR, APP_VERSION } from "./config.js";
import { ValidationError, validateChatPayload } from "./messages.js";
import { DolphinError, completeChat, streamChat } from "./dolphin.js";
import { catalogIds } from "./catalog.js";
import { clientKey } from "./ratelimit.js";
import { demoStream, demoTextFrom } from "./demo.js";
import { SSE_HEADERS, sseFrame } from "./sse.js";
import { locateIp, isGeoEnabled } from "./geo.js";
import {
  authenticateRequest,
  registerUser,
  loginUser,
  logoutUser,
  extractSessionToken,
} from "./auth.js";
import {
  saveMessage,
  recordUserActivity,
  getAdminStats,
  getAdminUsersList,
  getUserMessages,
  updateUserStatus,
  updateUserAlert,
  getDbStatus,
  upsertConversation,
  getUserHistory,
  softDeleteConversation,
  softDeleteAllConversations,
  SESSION_DAYS,
} from "./db.js";

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

/** Identifiant de conversation accepté (même gabarit que les autres ID). */
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;

/** Renvoie un identifiant de conversation propre, ou null. */
export function cleanConversationId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return CONVERSATION_ID_PATTERN.test(trimmed) ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Helpers de réponse                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cookie de session PERSISTANT (survit à la fermeture du navigateur et aux
 * longues inactivités) : 90 jours, renouvelé automatiquement à chaque
 * prolongation glissante de la session côté serveur.
 * `Secure` est ajouté en HTTPS (Render, aperçu sandbox) pour la production.
 */
export function buildSessionCookie(req, token, days = SESSION_DAYS) {
  const proto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const secure = proto === "https" || process.env.NODE_ENV === "production";
  return (
    `venice_session=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.round(days * 86400)}; ` +
    `SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`
  );
}

/** Cookie d'effacement de session (déconnexion). */
export function buildSessionClearCookie() {
  return "venice_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly";
}

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

  // Authentification et contrôle du trafic pour cette IA uncensored
  let auth = null;
  try {
    auth = await authenticateRequest(req);
  } catch (err) {
    if (err.dbUnavailable) {
      // Base momentanément injoignable : ce n'est PAS une session invalide.
      // On renvoie 503 pour que le client conserve sa session et réessaie.
      console.warn("[chat] Base de données momentanément indisponible :", err.message);
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Service momentanément indisponible — votre session est conservée, réessayez dans un instant.",
        },
      });
      return;
    }
    console.warn("[chat] Erreur auth :", err.message);
  }

  const isTest = Boolean(process.env.NODE_TEST_CONTEXT);

  // Exiger l'authentification (sauf en suite de test automatisée)
  if (!auth && !isTest) {
    sendJson(res, 401, {
      error: {
        status: 401,
        code: "LOGIN_REQUIRED",
        message: "Veuillez vous inscrire ou vous connecter pour discuter avec Venice.",
      },
    });
    return;
  }

  if (auth) {
    if (auth.user.status === "banned") {
      sendJson(res, 403, {
        error: {
          status: 403,
          code: "ACCOUNT_BANNED",
          message: "Votre compte a été banni. L'accès au chat est restreint.",
        },
      });
      return;
    }
    if (auth.user.status === "suspended") {
      sendJson(res, 403, {
        error: {
          status: 403,
          code: "ACCOUNT_SUSPENDED",
          message: "Votre compte est temporairement suspendu.",
        },
      });
      return;
    }
  }

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

  // Enregistrement du message utilisateur pour surveillance du trafic
  const lastUserMsg = payload.messages[payload.messages.length - 1];
  const userPromptText = lastUserMsg?.content || "";
  const ip = clientKey(req, { trustProxy: cfg.trustProxy });
  const promptTokensEst = Math.ceil(userPromptText.length / 4);

  // Identifiant de conversation assaini : relie chaque message à son fil de
  // discussion en base, pour que l'historique survive aux déconnexions.
  const conversationId = cleanConversationId(body.conversationId);

  if (auth) {
    if (conversationId) {
      // Le titre n'est défini qu'à la création (COALESCE côté base) : les
      // renommages faits par l'utilisateur ne sont jamais écrasés.
      // `revive: true` — écrire dans une conversation la fait réapparaître.
      const firstUserLine = payload.messages.find((m) => m.role === "user")?.content || userPromptText;
      const autoTitle = firstUserLine.replace(/\s+/g, " ").trim().slice(0, 58) || null;
      try {
        await upsertConversation({
          id: conversationId,
          userId: auth.user.id,
          title: autoTitle,
          model: payload.model,
          template: payload.template,
          instructions: payload.instructions || null,
          updatedAt: new Date().toISOString(),
          revive: true,
        });
      } catch (err) {
        // La persistance de la conversation ne doit jamais casser le chat.
        console.warn("[chat] Conversation non persistée :", err.message);
      }
    }
    await saveMessage({
      userId: auth.user.id,
      username: auth.user.username,
      conversationId,
      role: "user",
      content: userPromptText,
      model: payload.model,
      template: payload.template,
      tokensEstimate: promptTokensEst,
      ip,
    });
    await recordUserActivity(auth.user.id, { tokens: promptTokensEst });
  }

  /* ----------------------------- Mode démo ------------------------------ */
  if (cfg.demoMode) {
    const lastUser = payload.messages[payload.messages.length - 1].content;
    if (!wantsStream) {
      const reply = demoTextFrom(lastUser);
      if (auth) {
        const replyTokens = Math.ceil(reply.length / 4);
        await saveMessage({
          userId: auth.user.id,
          username: auth.user.username,
          conversationId,
          role: "assistant",
          content: reply,
          model: payload.model,
          template: payload.template,
          tokensEstimate: replyTokens,
          ip,
        });
        await recordUserActivity(auth.user.id, { tokens: replyTokens });
      }
      sendJson(res, 200, {
        reply,
        model: payload.model,
        template: payload.template,
        demo: true,
      });
      return;
    }
    res.writeHead(200, SSE_HEADERS);
    res.write(sseFrame({ status: "started", demo: true, model: payload.model, template: payload.template }));
    let demoAccumulated = "";
    for await (const delta of demoStream(lastUser)) {
      demoAccumulated += delta;
      res.write(sseFrame({ delta }));
    }
    if (auth && demoAccumulated) {
      const replyTokens = Math.ceil(demoAccumulated.length / 4);
      await saveMessage({
        userId: auth.user.id,
        username: auth.user.username,
        conversationId,
        role: "assistant",
        content: demoAccumulated,
        model: payload.model,
        template: payload.template,
        tokensEstimate: replyTokens,
        ip,
      });
      await recordUserActivity(auth.user.id, { tokens: replyTokens });
    }
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
      if (auth) {
        const replyTokens = Math.ceil(reply.length / 4);
        await saveMessage({
          userId: auth.user.id,
          username: auth.user.username,
          conversationId,
          role: "assistant",
          content: reply,
          model: payload.model,
          template: payload.template,
          tokensEstimate: replyTokens,
          ip,
        });
        await recordUserActivity(auth.user.id, { tokens: replyTokens });
      }
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

  let streamAccumulated = "";

  try {
    for await (const delta of streamChat({
      cfg,
      session,
      payload: { ...payload, systemPrompt: cfg.systemPrompt },
      signal: controller.signal,
      log: console,
    })) {
      if (res.writableEnded) break;
      streamAccumulated += delta;
      res.write(sseFrame({ delta }));
    }

    if (auth && streamAccumulated) {
      const replyTokens = Math.ceil(streamAccumulated.length / 4);
      await saveMessage({
        userId: auth.user.id,
        username: auth.user.username,
        conversationId,
        role: "assistant",
        content: streamAccumulated,
        model: payload.model,
        template: payload.template,
        tokensEstimate: replyTokens,
        ip,
      });
      await recordUserActivity(auth.user.id, { tokens: replyTokens });
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
    // État du stockage : "postgres" = persistance garantie (survit aux déploiements).
    storage: getDbStatus(),
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
/* Authentification                                                           */
/* -------------------------------------------------------------------------- */

export async function handleAuthRegister(req, res, runtime = null) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  try {
    const body = await readJsonBody(req);

    // Capture IP + localisation approximative côté SERVEUR, à l'inscription.
    // Ces valeurs ne proviennent JAMAIS du corps de la requête (le client ne
    // peut ni les fournir ni les influencer) et ne sont JAMAIS renvoyées au
    // navigateur : ce sont des données fixes du tableau admin.
    // Un échec de géolocalisation ne bloque pas l'inscription (l'IP reste
    // enregistrée, la localisation reste vide).
    const ip = clientKey(req, { trustProxy: runtime?.cfg?.trustProxy ?? true });
    let geo = { ip, location: null, countryCode: null };
    try {
      geo = await locateIp(ip, {
        enabled: isGeoEnabled(process.env),
        timeoutMs: 6000,
      });
    } catch {
      /* la localisation reste vide — l'inscription continue */
    }

    const result = await registerUser({
      ...body,
      register_ip: geo.ip,
      location: geo.location,
      country_code: geo.countryCode,
    });

    res.setHeader("Set-Cookie", buildSessionCookie(req, result.token));
    sendJson(res, 201, {
      ok: true,
      user: result.user,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    sendJson(res, error.status || 400, {
      error: { status: error.status || 400, message: error.message },
    });
  }
}

export async function handleAuthLogin(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  try {
    const body = await readJsonBody(req);
    const result = await loginUser(body);

    res.setHeader("Set-Cookie", buildSessionCookie(req, result.token));
    sendJson(res, 200, {
      ok: true,
      user: result.user,
      token: result.token,
      expiresAt: result.expiresAt,
      isAdmin: result.isAdmin,
    });
  } catch (error) {
    sendJson(res, error.status || 401, {
      error: {
        status: error.status || 401,
        code: error.code || "AUTH_FAILED",
        message: error.message,
      },
    });
  }
}

export async function handleAuthMe(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }

  let auth;
  try {
    auth = await authenticateRequest(req);
  } catch (err) {
    if (err.dbUnavailable) {
      // La base est momentanément injoignable : on ne déconnecte jamais
      // l'utilisateur pour autant — la session est conservée côté client.
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Vérification de session momentanément indisponible — session conservée.",
        },
      });
      return;
    }
    throw err;
  }

  if (!auth) {
    sendJson(res, 200, { authenticated: false, user: null });
    return;
  }

  // Session glissante : si la session a été prolongée, on renouvelle aussi le
  // cookie pour 90 jours — l'utilisateur reste connecté en continu.
  if (auth.sessionRefreshed) {
    res.setHeader("Set-Cookie", buildSessionCookie(req, auth.token));
  }
  sendJson(res, 200, {
    authenticated: true,
    user: auth.user,
    sessionExpiresAt: auth.sessionExpiresAt,
  });
}

export async function handleAuthLogout(req, res) {
  const token = extractSessionToken(req);
  if (token) {
    await logoutUser(token);
  }
  res.setHeader("Set-Cookie", buildSessionClearCookie());
  sendJson(res, 200, { ok: true });
}

export async function handleAuthDismissAlert(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth) {
    sendJson(res, 401, { error: { status: 401, message: "Non authentifié." } });
    return;
  }
  await updateUserAlert(auth.user.id, null);
  sendJson(res, 200, { ok: true });
}

/* -------------------------------------------------------------------------- */
/* Historique utilisateur (persisté en base — jamais détruit)                 */
/* -------------------------------------------------------------------------- */

/** Authentifie pour les routes d'historique ; renvoie null (et 401/503) sinon. */
async function ensureAuthenticated(req, res) {
  let auth;
  try {
    auth = await authenticateRequest(req);
  } catch (err) {
    if (err.dbUnavailable) {
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Historique momentanément indisponible — réessayez dans un instant.",
        },
      });
      return null;
    }
    throw err;
  }
  if (!auth) {
    sendJson(res, 401, {
      error: {
        status: 401,
        code: "LOGIN_REQUIRED",
        message: "Connectez-vous pour retrouver votre historique.",
      },
    });
    return null;
  }
  return auth;
}

/**
 * GET /api/history — conversations de l'utilisateur connecté, avec leurs
 * messages (les plus récentes d'abord). C'est la source de vérité : elle
 * permet de tout retrouver après une déconnexion/reconnexion ou un
 * changement d'appareil.
 */
export async function handleHistoryGet(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  const auth = await ensureAuthenticated(req, res);
  if (!auth) return;

  try {
    const conversations = await getUserHistory(auth.user.id);
    sendJson(res, 200, { ok: true, conversations });
  } catch (err) {
    if (err.dbUnavailable) {
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Historique momentanément indisponible — réessayez dans un instant.",
        },
      });
      return;
    }
    throw err;
  }
}

/**
 * POST /api/history/conversation — crée ou met à jour les métadonnées d'une
 * conversation (titre, modèle, rôle, instructions, horodatage). Les messages
 * eux-mêmes sont enregistrés par POST /api/chat.
 */
export async function handleConversationUpsert(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  const auth = await ensureAuthenticated(req, res);
  if (!auth) return;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendError(res, error);
    return;
  }

  const id = cleanConversationId(body.id);
  if (!id) {
    sendJson(res, 400, {
      error: { status: 400, message: 'Identifiant de conversation ("id") invalide.' },
    });
    return;
  }

  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 90) : null;
  const model = typeof body.model === "string" ? body.model.slice(0, 60) : null;
  const template = typeof body.template === "string" ? body.template.slice(0, 60) : null;
  const instructions =
    typeof body.instructions === "string" && body.instructions.trim()
      ? body.instructions.slice(0, 4000)
      : null;
  const createdAt = Number.isFinite(Number(body.createdAt)) ? Number(body.createdAt) : null;
  const updatedAt = Number.isFinite(Number(body.updatedAt)) ? Number(body.updatedAt) : null;

  try {
    const conversation = await upsertConversation({
      id,
      userId: auth.user.id,
      title,
      model,
      template,
      instructions,
      createdAt: createdAt ? new Date(createdAt).toISOString() : null,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null,
      revive: false,
      // Un titre non vide envoyé par le client est un renommage explicite :
      // il remplace le titre existant (auto-titre ou renommage précédent).
      forceTitle: Boolean(title),
    });
    sendJson(res, 200, { ok: true, id: conversation?.id || id });
  } catch (err) {
    if (err.dbUnavailable) {
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Sauvegarde momentanément indisponible — réessayez dans un instant.",
        },
      });
      return;
    }
    throw err;
  }
}

/**
 * DELETE /api/history/conversation/:id — masque une conversation pour
 * l'utilisateur (suppression LOGIQUE : deleted_at). Les messages restent en
 * base à jamais, exactement comme dans le panneau admin.
 */
export async function handleConversationDelete(req, res, conversationId) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  const auth = await ensureAuthenticated(req, res);
  if (!auth) return;

  const id = cleanConversationId(conversationId);
  if (!id) {
    sendJson(res, 400, {
      error: { status: 400, message: "Identifiant de conversation invalide." },
    });
    return;
  }

  try {
    const deleted = await softDeleteConversation(auth.user.id, id);
    sendJson(res, 200, { ok: true, id, deleted });
  } catch (err) {
    if (err.dbUnavailable) {
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Suppression momentanément indisponible — réessayez dans un instant.",
        },
      });
      return;
    }
    throw err;
  }
}

/**
 * DELETE /api/history — masque TOUTES les conversations de l'utilisateur
 * (suppression logique uniquement ; rien n'est jamais détruit en base).
 */
export async function handleHistoryDeleteAll(req, res) {
  if (req.method !== "DELETE") {
    res.setHeader("Allow", "DELETE");
    sendJson(res, 405, { error: { status: 405, message: "Méthode non autorisée." } });
    return;
  }
  const auth = await ensureAuthenticated(req, res);
  if (!auth) return;

  try {
    const count = await softDeleteAllConversations(auth.user.id);
    sendJson(res, 200, { ok: true, hidden: count });
  } catch (err) {
    if (err.dbUnavailable) {
      sendJson(res, 503, {
        error: {
          status: 503,
          code: "DB_UNAVAILABLE",
          message: "Suppression momentanément indisponible — réessayez dans un instant.",
        },
      });
      return;
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/* Administration                                                             */
/* -------------------------------------------------------------------------- */

async function ensureAdmin(req, res) {
  const auth = await authenticateRequest(req);
  if (!auth || auth.user.role !== "admin") {
    sendJson(res, 403, {
      error: {
        status: 403,
        code: "ADMIN_REQUIRED",
        message: "Accès réservé aux administrateurs.",
      },
    });
    return null;
  }
  return auth;
}

export async function handleAdminStats(req, res) {
  const admin = await ensureAdmin(req, res);
  if (!admin) return;
  const stats = await getAdminStats();
  sendJson(res, 200, stats);
}

export async function handleAdminUsers(req, res) {
  const admin = await ensureAdmin(req, res);
  if (!admin) return;
  const users = await getAdminUsersList();
  sendJson(res, 200, users);
}

export async function handleAdminUserMessages(req, res, userId) {
  const admin = await ensureAdmin(req, res);
  if (!admin) return;
  const messages = await getUserMessages(userId, 200);
  sendJson(res, 200, messages);
}

export async function handleAdminUserStatus(req, res, userId) {
  const admin = await ensureAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  const { status } = body;
  if (!["active", "suspended", "banned"].includes(status)) {
    sendJson(res, 400, { error: { status: 400, message: "Statut invalide." } });
    return;
  }
  await updateUserStatus(userId, status);
  sendJson(res, 200, { ok: true, userId, status });
}

export async function handleAdminUserAlert(req, res, userId) {
  const admin = await ensureAdmin(req, res);
  if (!admin) return;
  const body = await readJsonBody(req);
  await updateUserAlert(userId, body.alertMessage);
  sendJson(res, 200, { ok: true, userId, alertMessage: body.alertMessage });
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
