// config.js — configuration centralisée de Venice (source de vérité unique).
//
// Venice v2 est une PASSERELLE : le navigateur parle à ce serveur, qui parle
// au chat officiel Dolphin (https://chat.dphn.ai/) en se présentant comme un
// navigateur réel (cookies Cloudflare obtenus par Chromium headless).
//
// 🔐 Aucun secret n'est nécessaire pour Dolphin : l'accès repose sur les
//    cookies `cf_clearance` + `__cf_ob` récupérés automatiquement par
//    Playwright (lib/cloudflare.js). Les variables d'environnement ne font
//    que régler le comportement de la passerelle.

import { VENICE_PROMPT } from "./src/prompt.js";
import { buildSkillsSection } from "./src/skills.js";
import { DEFAULT_MODEL, DEFAULT_TEMPLATE } from "./src/catalog.js";

export const APP_NAME = "Venice";
export const APP_AUTHOR = "Crazy Prince";
export const APP_VERSION = "2.0.0";
export const APP_TAGLINE = "Chat Dolphin, sans friction.";

export { DEFAULT_MODEL, DEFAULT_TEMPLATE };

/** Cible scrapée. */
export const DOLPHIN_BASE_URL = "https://chat.dphn.ai";

/**
 * User-Agent utilisé pour le navigateur headless ET pour les appels HTTP.
 * Il doit être identique aux deux étapes : Cloudflare lie `cf_clearance` à
 * l'empreinte (IP + User-Agent) qui a résolu le challenge.
 */
export const DOLPHIN_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Prompt système complet : identité de Venice + compétences. */
export const DEFAULT_SYSTEM_PROMPT = `${VENICE_PROMPT}\n\n# COMPÉTENCES\n\n${buildSkillsSection()}`;

/** Défauts numériques (surchargés par les variables d'environnement). */
export const DEFAULTS = {
  cookieTtlMs: 20 * 60_000, // les cookies CF vivent ~30 min à quelques heures
  refreshIntervalMs: 12 * 60_000, // rafraîchissement préventif en boucle
  solverTimeoutMs: 90_000, // temps laissé au challenge Cloudflare
  requestTimeoutMs: 30_000, // appels JSON (/api/models, /api/templates)
  streamIdleMs: 60_000, // coupure si le flux SSE n'émet plus rien
  streamTotalMs: 10 * 60_000, // garde-fou absolu d'une génération
  catalogTtlMs: 10 * 60_000, // cache du catalogue modèles/rôles
  rateLimit: 30, // requêtes /api/chat par minute et par IP (0 = illimité)
  rateWindowMs: 60_000,
  maxMessages: 41, // system + 20 échanges
  maxMessageChars: 8_000,
  maxTotalChars: 60_000,
};

const SYSTEM_MODES = new Set(["auto", "system", "message", "none"]);

function num(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

/**
 * Lit toute la configuration depuis l'environnement.
 * @param {NodeJS.ProcessEnv} env
 */
export function getConfig(env = process.env) {
  const demoMode = bool(env.DEMO_MODE, false);
  const solverMode = (env.DOLPHIN_SOLVER || "playwright").toLowerCase();
  const systemModeRaw = (env.DOLPHIN_SYSTEM_MODE || "auto").toLowerCase();

  return {
    app: { name: APP_NAME, author: APP_AUTHOR, version: APP_VERSION, tagline: APP_TAGLINE },

    // --- Cible ------------------------------------------------------------
    baseUrl: (env.DOLPHIN_BASE_URL || DOLPHIN_BASE_URL).replace(/\/+$/, ""),
    userAgent: env.DOLPHIN_USER_AGENT || DOLPHIN_USER_AGENT,

    // --- Session Cloudflare ----------------------------------------------
    // Cookie injecté à la main (dev, debug, dépannage) : "cf_clearance=…; __cf_ob=…"
    cookie: (env.DOLPHIN_COOKIE || "").trim(),
    cookieTtlMs: num(env.DOLPHIN_COOKIE_TTL_MS, DEFAULTS.cookieTtlMs, { min: 30_000 }),
    refreshIntervalMs: num(env.DOLPHIN_REFRESH_INTERVAL_MS, DEFAULTS.refreshIntervalMs, {
      min: 30_000,
    }),
    refreshOnBoot: bool(env.DOLPHIN_REFRESH_ON_BOOT, true),

    // --- Solveur (Chromium headless) -------------------------------------
    solver: {
      mode: solverMode === "none" || solverMode === "off" ? "none" : "playwright",
      module: env.PLAYWRIGHT_MODULE || "playwright", // ex. "patchright" si CF durcit
      headless: bool(env.DOLPHIN_SOLVER_HEADLESS, true),
      timeoutMs: num(env.DOLPHIN_SOLVER_TIMEOUT_MS, DEFAULTS.solverTimeoutMs, { min: 5_000 }),
      locale: env.DOLPHIN_LOCALE || "fr-FR",
      timezone: env.DOLPHIN_TIMEZONE || "Europe/Paris",
    },

    // --- Réseau / streaming ----------------------------------------------
    requestTimeoutMs: num(env.DOLPHIN_REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, {
      min: 1_000,
    }),
    streamIdleMs: num(env.DOLPHIN_STREAM_IDLE_MS, DEFAULTS.streamIdleMs, { min: 5_000 }),
    streamTotalMs: num(env.DOLPHIN_STREAM_TOTAL_MS, DEFAULTS.streamTotalMs, { min: 10_000 }),
    retries: num(env.DOLPHIN_RETRIES, 1, { min: 0, max: 3 }),
    catalogTtlMs: num(env.DOLPHIN_CATALOG_TTL_MS, DEFAULTS.catalogTtlMs, { min: 10_000 }),

    // --- Payload amont ----------------------------------------------------
    // "auto"   : essaie role=system, dégrade tout seul si Dolphin refuse
    // "system" : force un message système
    // "message": préfixe les consignes au premier message utilisateur
    // "none"   : n'envoie que la conversation
    systemMode: SYSTEM_MODES.has(systemModeRaw) ? systemModeRaw : "auto",
    extraBody: parseJsonObject(env.DOLPHIN_EXTRA_BODY, {}),

    // --- Interface / API --------------------------------------------------
    systemPrompt: env.VENICE_SYSTEM_PROMPT?.trim() || DEFAULT_SYSTEM_PROMPT,
    demoMode,
    rateLimit: num(env.VENICE_RATE_LIMIT, DEFAULTS.rateLimit, { min: 0 }),
    rateWindowMs: num(env.VENICE_RATE_WINDOW_MS, DEFAULTS.rateWindowMs, { min: 1_000 }),
    adminToken: (env.ADMIN_TOKEN || "").trim(),
    trustProxy: bool(env.TRUST_PROXY, true),
    history: {
      contextWindow: num(env.VENICE_CONTEXT_WINDOW, 20, { min: 1, max: 40 }),
      storedMessages: num(env.VENICE_STORED_MESSAGES, 80, { min: 10, max: 500 }),
      maxConversations: num(env.VENICE_MAX_CONVERSATIONS, 60, { min: 1, max: 500 }),
    },
    limits: {
      maxMessages: DEFAULTS.maxMessages,
      maxMessageChars: DEFAULTS.maxMessageChars,
      maxTotalChars: DEFAULTS.maxTotalChars,
    },
    port: num(env.PORT, 3000, { min: 1, max: 65535 }),
    host: env.HOST || "0.0.0.0",
  };
}

function parseJsonObject(value, fallback) {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    console.warn("[config] DOLPHIN_EXTRA_BODY ignoré : JSON invalide.");
    return fallback;
  }
}
