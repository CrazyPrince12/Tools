// dolphin.js — client de la passerelle vers le chat officiel Dolphin.
//
// C'est le « scraper » au sens strict : on rejoue exactement ce que fait le
// navigateur (mêmes routes, mêmes en-têtes, mêmes cookies), avec un fetch
// Node natif (undici) — validé en tests réels :
//
//   GET  /api/models     → {"data":[{"id":"dolphinserver:24B","label":"…"}]}
//   GET  /api/templates  → {"data":[{"name":"logical"}, …]}
//   POST /api/chat       → SSE (chunks `chat.completion.chunk`, format OpenAI)
//                          body {"messages":[…],"model":"…","template":"…"}
//
// Deux pièges gérés ici :
//   1. Cloudflare : 403 `cf-mitigated: challenge` → on rafraîchit la session
//      (Playwright) et on rejoue la requête une fois ;
//   2. schéma amont non documenté : les trames SSE sont parsées de façon
//      tolérante (voir lib/sse.js) et le mode du message système se négocie
//      tout seul si Dolphin refuse `role:"system"`.

import { parseSSE, parseJsonData, extractDelta, isDone } from "./sse.js";
import { buildUpstreamMessages } from "./messages.js";

/** Erreur normalisée remontée à la couche HTTP. */
export class DolphinError extends Error {
  constructor(status, message, { code, detail, retryable = false } = {}) {
    super(message);
    this.name = "DolphinError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.retryable = retryable;
  }
}

/** L'amont a répondu par un challenge Cloudflare : la session doit être rafraîchie. */
export class ChallengeError extends DolphinError {
  constructor(message = "Cloudflare exige une nouvelle validation de session.", detail) {
    super(403, message, { code: "CF_CHALLENGE", detail, retryable: true });
    this.name = "ChallengeError";
  }
}

/** Messages d'erreur Dolphin connus (l'API renvoie des codes courts : {"error":"E4"}). */
const UPSTREAM_CODES = {
  E1: "Requête mal formée.",
  E2: "Session invalide ou expirée.",
  E3: "Limite d'utilisation atteinte côté Dolphin.",
  E4: "Payload refusé par Dolphin (modèle, rôle ou historique non accepté).",
  E5: "Modèle indisponible pour le moment.",
};

/* -------------------------------------------------------------------------- */
/* En-têtes de navigateur                                                     */
/* -------------------------------------------------------------------------- */

export function upstreamHeaders(cfg, session, { json = false, accept, origin = true } = {}) {
  const headers = {
    // L'ordre et la valeur des en-têtes comptent : Cloudflare lie le cookie
    // à l'empreinte (IP + UA) qui a résolu le challenge.
    "user-agent": cfg.userAgent,
    accept: accept ?? "application/json, text/plain, */*",
    "accept-language": `${cfg.solver.locale},${cfg.solver.locale.split("-")[0]};q=0.9,en;q=0.8`,
    cookie: session.cookieHeader,
    "cache-control": "no-cache",
    pragma: "no-cache",
  };
  if (json) headers["content-type"] = "application/json";
  if (origin) {
    headers.origin = cfg.baseUrl;
    headers.referer = `${cfg.baseUrl}/`;
    headers["sec-fetch-site"] = "same-origin";
    headers["sec-fetch-mode"] = "cors";
    headers["sec-fetch-dest"] = "empty";
  }
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Détection du challenge                                                     */
/* -------------------------------------------------------------------------- */

/** Indique si une réponse est (probablement) un challenge Cloudflare. */
export function isChallengeResponse(res, bodyText = "") {
  if (res.headers.get("cf-mitigated") === "challenge") return true;
  if (res.status === 403) return true;
  if (res.status === 503 && res.headers.get("server")?.includes("cloudflare")) return true;
  if (/^<!doctype html|^<html/i.test(bodyText.trim().slice(0, 200))) {
    return /just a moment|cf-chl|challenge-platform|enable javascript and cookies/i.test(bodyText);
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Requête HTTP amont                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Erreur explicite quand l'amont demande un challenge ALORS QUE la passerelle
 * n'a aucune session utilisable.
 *
 * Sans ce cas particulier, l'utilisateur voyait « Cloudflare exige une nouvelle
 * validation de session » (code `CF_CHALLENGE`) alors que la vraie cause est
 * souvent locale : aucun Chromium installable (Vercel, Netlify, Lambda), cookie
 * absent, solveur désactivé… Un `CF_CHALLENGE` laisse croire qu'un simple
 * rafraîchissement suffirait, ce qui envoie sur une fausse piste.
 */
function noSessionError(cfg, session, cause, where) {
  const diagnostic = session.diagnostic?.() ?? null;
  const platform = cfg.platform ?? { name: "node", label: "Node", serverless: false };
  const serverless = Boolean(platform.serverless);

  const code = serverless && !session.hasCookie ? "NO_BROWSER" : "NO_SESSION";
  const message = serverless && !session.hasCookie
    ? `Aucune session Cloudflare : ${platform.label} ne peut pas résoudre le challenge.`
    : `Aucune session Cloudflare disponible : ${cause?.message || diagnostic?.message || "cause inconnue"}.`;

  const detail = [
    where,
    code,
    serverless
      ? `héberger la passerelle sur un conteneur (Render/Docker/Fly.io) — voir « Déploiement Vercel » dans le README`
      : diagnostic?.hint,
  ]
    .filter(Boolean)
    .join(" · ");

  return new DolphinError(503, message, { code, detail, retryable: false });
}

/**
 * Exécute une requête sur l'amont, avec un rejeu automatique si Cloudflare
 * invalide la session en cours de route.
 * @returns {Promise<Response>} réponse amont (non encore consommée)
 */
export async function upstreamFetch(cfg, session, path, options = {}) {
  const { method = "GET", body, accept, signal, retries = cfg.retries } = options;
  let lastError = null;
  let sessionError = null; // dernière raison pour laquelle aucune session n'a pu être obtenue

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!session.hasCookie && session.cfg.solver.mode !== "none") {
      try {
        await session.ensureFresh({ reason: "no-cookie" });
        sessionError = null;
      } catch (error) {
        // On mémorise l'échec : c'est presque toujours la VRAIE cause du 403
        // qui va suivre. Il ne doit pas être avalé silencieusement.
        sessionError = error;
      }
    }

    const res = await fetch(`${cfg.baseUrl}${path}`, {
      method,
      headers: upstreamHeaders(cfg, session, {
        json: body !== undefined,
        accept: accept ?? "application/json, text/plain, */*",
      }),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "follow",
    });

    // 403/503 : on ne peut trancher qu'en lisant un bout du corps.
    if (res.status === 403 || res.status === 503) {
      const text = await res.text().catch(() => "");
      if (isChallengeResponse(res, text)) {
        // Aucun cookie à rafraîchir : ce n'est pas un challenge à rejouer,
        // c'est une passerelle incapable d'obtenir une session.
        if (!session.hasCookie) {
          throw noSessionError(cfg, session, sessionError, `HTTP ${res.status} sur ${path}`);
        }
        lastError = new ChallengeError(undefined, `HTTP ${res.status} sur ${path}`);
        if (attempt < retries) {
          await session.recover(`${method} ${path}`).catch((error) => {
            lastError = error;
          });
          continue; // rejeu avec un cookie neuf
        }
        throw lastError;
      }
      throw new DolphinError(res.status, `Dolphin a refusé la requête (HTTP ${res.status}).`, {
        detail: text.slice(0, 300),
      });
    }

    if (!res.ok) throw await errorFromResponse(res, path);
    return res;
  }

  throw lastError ?? new DolphinError(502, "Impossible de joindre Dolphin.");
}

/** Traduit une réponse d'erreur amont en DolphinError lisible. */
async function errorFromResponse(res, path) {
  const text = await res.text().catch(() => "");
  let code;
  try {
    const parsed = JSON.parse(text);
    code = typeof parsed?.error === "string" ? parsed.error : parsed?.error?.code;
  } catch {
    /* corps non JSON */
  }

  const detail = code
    ? `${code} — ${UPSTREAM_CODES[code] ?? "code inconnu"}`
    : text.slice(0, 200) || undefined;

  if (res.status === 401 || res.status === 419) {
    return new DolphinError(401, "Session Dolphin expirée. Réessayez : la passerelle va se reconnecter.", {
      code: code || "SESSION",
      detail,
      retryable: true,
    });
  }
  if (res.status === 429) {
    return new DolphinError(429, "Dolphin limite temporairement les requêtes. Patientez un instant.", {
      code: code || "RATE_LIMIT",
      detail,
    });
  }
  if (res.status >= 500) {
    return new DolphinError(502, "Le chat Dolphin rencontre une erreur. Réessayez dans un instant.", {
      code: code || "UPSTREAM_5XX",
      detail,
    });
  }
  return new DolphinError(400, "Requête refusée par Dolphin.", { code: code || "BAD_REQUEST", detail });
}

/* -------------------------------------------------------------------------- */
/* Catalogue : modèles + rôles                                                */
/* -------------------------------------------------------------------------- */

/** Lit un endpoint JSON de Dolphin et renvoie son tableau `data`. */
export async function fetchJsonList(cfg, session, path) {
  const res = await upstreamFetch(cfg, session, path, {
    accept: "application/json, text/plain, */*",
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DolphinError(502, `Réponse illisible sur ${path}.`, { detail: text.slice(0, 200) });
  }
  const data = Array.isArray(parsed) ? parsed : parsed?.data;
  if (!Array.isArray(data)) {
    throw new DolphinError(502, `Champ "data" absent sur ${path}.`, { detail: text.slice(0, 200) });
  }
  return data;
}

/** Catalogue complet : modèles + rôles (templates), en parallèle. */
export async function fetchCatalog(cfg, session) {
  const [models, templates] = await Promise.all([
    fetchJsonList(cfg, session, "/api/models"),
    fetchJsonList(cfg, session, "/api/templates"),
  ]);
  return { models, templates };
}

/* -------------------------------------------------------------------------- */
/* Chat : streaming SSE                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Négociation du mode « message système ».
 *
 * Dolphin expose `template` (le rôle) mais sa gestion de `role:"system"` n'est
 * pas documentée. En mode "auto", on tente `system`, et si l'amont refuse le
 * payload (400) avant le moindre token, on dégrade automatiquement :
 *     system → message (consignes préfixées au dernier message utilisateur) → none
 * Le mode retenu est mémorisé pour le processus : la négociation ne coûte
 * qu'une requête, une seule fois.
 */
const MODE_ORDER = ["system", "message", "none"];
let negotiatedMode = null;

export function currentSystemMode(cfg) {
  if (cfg.systemMode !== "auto") return cfg.systemMode;
  return negotiatedMode ?? "system";
}

export function resetSystemMode() {
  negotiatedMode = null;
}

/**
 * Ouvre le flux SSE amont et renvoie le lecteur + la réponse.
 * Les erreurs de payload (400) en mode auto font dégrader le mode système.
 */
async function openChatStream(cfg, session, payload, { signal, log }) {
  const maxDegradations = cfg.systemMode === "auto" ? MODE_ORDER.length : 1;
  let lastError = null;

  for (let step = 0; step < maxDegradations; step += 1) {
    const mode = currentSystemMode(cfg);
    const body = {
      messages: buildUpstreamMessages({
        messages: payload.messages,
        systemPrompt: payload.systemPrompt,
        instructions: payload.instructions,
        mode,
      }),
      model: payload.model,
      template: payload.template,
      ...cfg.extraBody,
    };

    let res;
    try {
      res = await upstreamFetch(cfg, session, "/api/chat", {
        method: "POST",
        body,
        accept: "text/event-stream, application/json, text/plain, */*",
        signal,
      });
    } catch (error) {
      // 400 « payload refusé » : on tente une stratégie système plus discrète.
      const degradable =
        cfg.systemMode === "auto" &&
        error instanceof DolphinError &&
        error.status === 400 &&
        mode !== "none";

      if (!degradable) throw error;
      lastError = error;
      const next = MODE_ORDER[MODE_ORDER.indexOf(mode) + 1] ?? "none";
      negotiatedMode = next;
      log?.warn?.(
        `[dolphin] payload refusé (${error.detail || error.message}) → mode message système "${next}"`
      );
      continue;
    }

    if (mode !== currentSystemMode(cfg)) return { res, mode: currentSystemMode(cfg) };
    if (cfg.systemMode === "auto" && negotiatedMode === null) negotiatedMode = mode;
    return { res, mode };
  }

  throw (
    lastError ??
    new DolphinError(400, "Dolphin refuse la requête, même sans message système.", {
      code: "E4",
    })
  );
}

/**
 * Stream de la réponse de Dolphin.
 * @returns {AsyncGenerator<string>} fragments de texte, dans l'ordre
 */
export async function* streamChat({ cfg, session, payload, signal, log = console }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener?.("abort", onAbort, { once: true });

  // Garde-fou : on coupe si l'amont n'émet plus rien pendant trop longtemps.
  let idleTimer = null;
  const bumpIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), cfg.streamIdleMs);
    idleTimer.unref?.();
  };
  const totalTimer = setTimeout(() => controller.abort(), cfg.streamTotalMs);
  totalTimer.unref?.();

  try {
    const { res } = await openChatStream(cfg, session, payload, { signal: controller.signal, log });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    // Cas 1 : l'amont a répondu en JSON (pas de streaming).
    if (contentType.includes("application/json")) {
      const parsed = parseJsonData(await res.text());
      if (parsed?.error) {
        throw new DolphinError(400, "Requête refusée par Dolphin.", { detail: String(parsed.error) });
      }
      const text = extractDelta(parsed) ?? parsed?.reply ?? "";
      if (text) yield text;
      return;
    }

    // Cas 2 : flux SSE.
    if (!res.body) throw new DolphinError(502, "Réponse vide de Dolphin.");
    bumpIdle();

    for await (const event of parseSSE(res.body)) {
      bumpIdle();
      if (isDone(event.data)) return;

      const parsed = parseJsonData(event.data);
      if (!parsed) {
        // Trame non JSON : on la traite comme du texte brut si elle est utile.
        const text = event.data.trim();
        if (text && text !== ":") yield text;
        continue;
      }
      if (parsed.error) {
        throw new DolphinError(400, "Dolphin a interrompu la génération.", {
          detail: typeof parsed.error === "string" ? parsed.error : JSON.stringify(parsed.error).slice(0, 200),
        });
      }
      const delta = extractDelta(parsed);
      if (delta) yield delta;
    }
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener?.("abort", onAbort);
  }
}

/** Réponse complète (mode non-stream) reconstruite depuis le flux. */
export async function completeChat(options) {
  let text = "";
  for await (const delta of streamChat(options)) text += delta;
  return text;
}
