// session.js — gestion de la session Cloudflare de la passerelle.
//
// Le cookie `cf_clearance` est la clé d'entrée chez Dolphin. Il expire
// (≈30 min à quelques heures) et Cloudflare peut le révoquer à tout moment
// (changement d'IP, de User-Agent, trafic inhabituel). Cette classe :
//
//   • conserve le cookie courant et sa date d'obtention ;
//   • le rafraîchit via le solveur Playwright (lib/cloudflare.js) ;
//   • déduplique les rafraîchissements concurrents (un seul navigateur) ;
//   • se rafraîchit périodiquement en tâche de fond ;
//   • se rafraîchit à la demande quand l'amont renvoie un 403 de challenge ;
//   • reste tolérante : si un rafraîchissement échoue mais qu'un cookie
//     existe encore, on continue avec lui et on journalise l'erreur.

import { solveCloudflareChallenge } from "./cloudflare.js";

export class DolphinSession {
  /**
   * @param {object} cfg                      configuration (getConfig())
   * @param {object} [deps]
   * @param {Function} [deps.solver]          injectable (tests : faux solveur)
   * @param {object}   [deps.log]             logger
   * @param {Function} [deps.now]             horloge injectable
   */
  constructor(cfg, deps = {}) {
    this.cfg = cfg;
    this.solver = deps.solver ?? solveCloudflareChallenge;
    this.log = deps.log ?? console;
    this.now = deps.now ?? (() => Date.now());

    this.cookieHeader = cfg.cookie || "";
    this.cookies = [];
    this.source = cfg.cookie ? "manual" : "none";
    this.obtainedAt = cfg.cookie ? this.now() : 0;
    this.verified = false;
    this.expiresAt = this.obtainedAt ? this.obtainedAt + cfg.cookieTtlMs : 0;

    this.refreshes = 0;
    this.failures = 0;
    this.lastError = null;
    this.lastReason = null;
    this.lastDurationMs = null;
    this.inFlight = null;
    this.timer = null;
  }

  /* ------------------------------------------------------------------ */
  /* Lecture                                                             */
  /* ------------------------------------------------------------------ */

  get hasCookie() {
    return Boolean(this.cookieHeader);
  }

  /** Le cookie est-il encore dans sa fenêtre de validité estimée ? */
  get isFresh() {
    return this.hasCookie && this.now() < this.expiresAt;
  }

  /** Âge du cookie en millisecondes (null si aucun cookie). */
  get ageMs() {
    return this.obtainedAt ? this.now() - this.obtainedAt : null;
  }

  /** État lisible par l'API /api/health. */
  get state() {
    if (!this.hasCookie) return "cold";
    if (this.inFlight) return "refreshing";
    if (this.isFresh) return "warm";
    return "stale";
  }

  /**
   * Diagnostic en clair : POURQUOI la passerelle est (ou non) connectée.
   *
   * C'est ce qui évite l'erreur trompeuse « Cloudflare exige une nouvelle
   * validation de session » quand la vraie cause est « aucun navigateur ne
   * peut être lancé sur cette plateforme ». `level: "error"` est définitif
   * (aucune requête ne peut aboutir en l'état), `"warn"` est temporaire.
   *
   * @returns {{level:"ok"|"warn"|"error", code:string, message:string, hint:string|null}}
   */
  diagnostic() {
    const platform = this.cfg.platform ?? { name: "node", label: "Node", serverless: false, hint: null };
    const serverless = Boolean(platform.serverless);

    if (this.cfg.demoMode) {
      return {
        level: "ok",
        code: "DEMO",
        message: "Mode démo : aucune session Cloudflare n'est nécessaire.",
        hint: null,
      };
    }

    if (this.hasCookie && this.state !== "stale") {
      return {
        level: "ok",
        code: "READY",
        message: `Session Cloudflare active (${this.source === "manual" ? "cookie fourni" : "Chromium headless"}).`,
        hint: null,
      };
    }

    if (serverless && !this.hasCookie) {
      return {
        level: "error",
        code: "NO_BROWSER",
        message: `${platform.label} ne peut pas résoudre le challenge Cloudflare : pas de Chromium persistant, IP de sortie instable.`,
        hint:
          "Hébergez la passerelle sur un conteneur (Render, Docker, Fly.io, VPS) et faites-la appeler par l'interface (réécriture /api/* ou VENICE_ALLOWED_ORIGINS) — ou passez DEMO_MODE=1.",
      };
    }

    if (this.cfg.solver.mode === "none" && !this.hasCookie) {
      return {
        level: "error",
        code: "NO_COOKIE",
        message: "Solveur désactivé (DOLPHIN_SOLVER=none) et aucun cookie fourni : aucune session ne peut exister.",
        hint: "Renseignez DOLPHIN_COOKIE (cf_clearance=…), ou laissez le solveur Playwright actif.",
      };
    }

    if (this.failures > 0 && !this.hasCookie) {
      return {
        level: "error",
        code: "SOLVER_FAILED",
        message: this.lastError || "Chromium n'a pas réussi à obtenir de cookie Cloudflare.",
        hint: this.lastReason === "manual"
          ? null
          : "Vérifiez que Chromium est installé (npx playwright install --with-deps chromium) ou injectez DOLPHIN_COOKIE obtenu depuis votre navigateur.",
      };
    }

    if (this.hasCookie) {
      return {
        level: "warn",
        code: "STALE",
        message: "Le cookie Cloudflare arrive en fin de validité : rafraîchissement en cours.",
        hint: null,
      };
    }

    return {
      level: "warn",
      code: "COLD",
      message: "Aucune session pour l'instant : elle sera obtenue au premier appel (Chromium headless).",
      hint: null,
    };
  }

  status() {
    return {
      state: this.state,
      source: this.source,
      hasCookie: this.hasCookie,
      cookieCount: this.cookies.length || (this.cookieHeader ? this.cookieHeader.split(";").length : 0),
      verified: this.verified,
      ageMs: this.ageMs,
      expiresInMs: this.obtainedAt ? Math.max(0, this.expiresAt - this.now()) : 0,
      refreshes: this.refreshes,
      failures: this.failures,
      lastReason: this.lastReason,
      lastError: this.lastError,
      lastDurationMs: this.lastDurationMs,
      solver: { mode: this.cfg.solver.mode, module: this.cfg.solver.module },
      platform: this.cfg.platform?.name ?? "node",
      diagnostic: this.diagnostic(),
      refreshing: Boolean(this.inFlight),
    };
  }

  /* ------------------------------------------------------------------ */
  /* Rafraîchissement                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Garantit un cookie utilisable (rafraîchit si nécessaire ou si `force`).
   * Les appels concurrents partagent le même rafraîchissement.
   * @returns {Promise<string>} l'en-tête Cookie à rejouer
   */
  async ensureFresh({ force = false, reason = "auto" } = {}) {
    if (!force && this.isFresh) return this.cookieHeader;
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.#refresh(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /** À appeler après un 403 amont : force un nouveau cookie puis le renvoie. */
  async recover(reason = "challenge") {
    this.log.warn?.(`[session] challenge Cloudflare détecté (${reason}) → rafraîchissement`);
    return this.ensureFresh({ force: true, reason });
  }

  async #refresh(reason) {
    const startedAt = this.now();
    this.lastReason = reason;

    if (this.cfg.solver.mode === "none") {
      if (this.hasCookie) {
        // Cookie manuel : on le prolonge d'une fenêtre, l'amont tranchera.
        this.obtainedAt = this.now();
        this.expiresAt = this.obtainedAt + this.cfg.cookieTtlMs;
        return this.cookieHeader;
      }
      const error = new Error(
        "Aucun cookie Dolphin disponible et solveur désactivé (DOLPHIN_SOLVER=none). Renseignez DOLPHIN_COOKIE."
      );
      this.#recordFailure(error, startedAt);
      throw error;
    }

    try {
      const result = await this.solver(this.cfg, { log: this.log });
      this.cookieHeader = result.cookieHeader;
      this.cookies = result.cookies ?? [];
      this.source = "playwright";
      this.verified = Boolean(result.verified);
      this.obtainedAt = result.obtainedAt ?? this.now();
      this.expiresAt = this.obtainedAt + this.cfg.cookieTtlMs;
      this.refreshes += 1;
      this.lastError = null;
      this.lastDurationMs = this.now() - startedAt;
      this.log.log?.(
        `[session] cookie Cloudflare rafraîchi (motif: ${reason}, ${this.cookies.length} cookies, ${this.lastDurationMs} ms)`
      );
      return this.cookieHeader;
    } catch (error) {
      this.#recordFailure(error, startedAt);

      // Un cookie ancien vaut mieux que rien : on continue avec lui et
      // l'appel amont décidera (il déclenchera un nouveau recover si besoin).
      if (this.hasCookie) {
        this.log.warn?.(
          `[session] rafraîchissement impossible (${error.message}) — utilisation du cookie existant.`
        );
        this.expiresAt = this.now() + 60_000; // nouvelle tentative dans 1 min
        return this.cookieHeader;
      }
      throw error;
    }
  }

  #recordFailure(error, startedAt) {
    this.failures += 1;
    this.lastError = error?.message || String(error);
    this.lastDurationMs = this.now() - startedAt;
    this.log.warn?.(`[session] échec du solveur : ${this.lastError}`);
  }

  /* ------------------------------------------------------------------ */
  /* Boucle de fond                                                      */
  /* ------------------------------------------------------------------ */

  /** Démarre le rafraîchissement périodique (idempotent). */
  start() {
    if (this.timer || this.cfg.refreshIntervalMs <= 0) return this;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.ensureFresh({ force: true, reason: "interval" }).catch((error) => {
        this.log.warn?.(`[session] rafraîchissement périodique échoué : ${error.message}`);
      });
    }, this.cfg.refreshIntervalMs);
    this.timer.unref?.();
    return this;
  }

  /** Arrête la boucle de fond (tests, arrêt propre). */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }

  /** Déclenche un premier rafraîchissement sans bloquer le démarrage. */
  prewarm() {
    if (this.isFresh && this.source === "manual") return this;
    this.ensureFresh({ force: !this.hasCookie, reason: "boot" }).catch((error) => {
      this.log.warn?.(`[session] préchauffage impossible : ${error.message}`);
    });
    return this;
  }
}

/**
 * Parse un en-tête Cookie brut en tableau de cookies Playwright-compatibles.
 * Utile pour injecter DOLPHIN_COOKIE à la main.
 */
export function parseCookieHeader(header, { domain = "chat.dphn.ai", path = "/" } = {}) {
  return String(header || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf("=");
      const name = eq === -1 ? part : part.slice(0, eq).trim();
      const value = eq === -1 ? "" : part.slice(eq + 1).trim();
      return { name, value, domain, path };
    })
    .filter((cookie) => cookie.name);
}
