// cloudflare.js — le « résolveur » de challenge.
//
// Constat vérifié : chat.dphn.ai est derrière Cloudflare en mode
// « managed challenge ». Tout fetch HTTP simple (curl, undici, axios) reçoit
// 403 + `cf-mitigated: challenge`, quelle que soit la route et quels que
// soient les en-têtes. La seule porte d'entrée est l'exécution du JavaScript
// de challenge dans un vrai moteur de rendu.
//
// Ce module démarre donc un Chromium headless (Playwright), laisse le
// challenge se résoudre, récupère les cookies de session (`cf_clearance`,
// `__cf_ob`, `__cf_bm`…) puis VÉRIFIE qu'ils fonctionnent réellement en
// appelant /api/models depuis la page. Le cookie peut ensuite être rejoué
// tel quel par un fetch Node natif (undici) — c'est le rôle de lib/session.js.

/** Le solveur n'est pas disponible (Playwright absent, plateforme non supportée…). */
export class SolverUnavailableError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SolverUnavailableError";
    this.code = "SOLVER_UNAVAILABLE";
    this.detail = detail;
  }
}

/** Le solveur a tourné mais n'a pas obtenu de cookie valide. */
export class SolverFailedError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = "SolverFailedError";
    this.code = "SOLVER_FAILED";
    this.detail = detail;
  }
}

/** En-têtes « humains » utilisés par le navigateur headless. */
function browserHeaders(cfg) {
  return {
    "accept-language": `${cfg.solver.locale},${cfg.solver.locale.split("-")[0]};q=0.9,en;q=0.8`,
  };
}

/**
 * Charge Playwright dynamiquement : l'application démarre (et l'UI
 * fonctionne) même si le navigateur n'est pas installé, le solveur échouant
 * alors avec un message explicite.
 */
export async function loadPlaywright(moduleName = "playwright") {
  try {
    const mod = await import(moduleName);
    return mod.chromium ? mod : mod.default;
  } catch (err) {
    throw new SolverUnavailableError(
      `Playwright est introuvable (module "${moduleName}"). Installez-le : npm install && npx playwright install --with-deps chromium.`,
      err?.message
    );
  }
}

/**
 * Résout le challenge Cloudflare et renvoie une session navigateur utilisable.
 *
 * @param {object} cfg               configuration (getConfig())
 * @param {object} [options]
 * @param {object} [options.log]     logger (console par défaut)
 * @param {(ms:number)=>Promise<void>} [options.sleep]  injectable pour les tests
 * @returns {Promise<{cookieHeader:string, cookies:Array, userAgent:string, verified:boolean, obtainedAt:number, elapsedMs:number, title:string}>}
 */
export async function solveCloudflareChallenge(cfg, options = {}) {
  const log = options.log ?? console;
  const startedAt = Date.now();

  if (cfg.solver.mode === "none") {
    throw new SolverUnavailableError(
      "Le solveur Playwright est désactivé (DOLPHIN_SOLVER=none). Fournissez un cookie manuel via DOLPHIN_COOKIE."
    );
  }

  const { chromium } = await loadPlaywright(cfg.solver.module);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: cfg.solver.headless,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-background-timer-throttling",
        "--no-first-run",
      ],
    });

    const context = await browser.newContext({
      userAgent: cfg.userAgent,
      locale: cfg.solver.locale,
      timezoneId: cfg.solver.timezone,
      viewport: { width: 1366, height: 840 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      colorScheme: "dark",
      extraHTTPHeaders: browserHeaders(cfg),
      bypassCSP: true,
    });

    const page = await context.newPage();
    log.log(`[cf] ouverture de ${cfg.baseUrl}/ (résolution du challenge)…`);

    await page.goto(`${cfg.baseUrl}/`, {
      waitUntil: "domcontentloaded",
      timeout: cfg.solver.timeoutMs,
    });

    // Certains challenges se résolvent d'eux-mêmes en 2 à 10 s.
    await waitForClearance({ page, context, cfg, log, startedAt });

    const cookies = await context.cookies(cfg.baseUrl);
    const cookieHeader = cookiesToHeader(cookies);
    const title = await page.title().catch(() => "");

    if (!cookieHeader.includes("cf_clearance")) {
      const turnstile = await hasTurnstile(page);
      throw new SolverFailedError(
        turnstile
          ? "Cloudflare exige un défi interactif (Turnstile) que le navigateur headless ne peut pas valider. Injectez un cookie manuel via DOLPHIN_COOKIE."
          : "Aucun cookie cf_clearance obtenu après expiration du délai.",
        `title=${JSON.stringify(title)} elapsed=${Date.now() - startedAt}ms`
      );
    }

    // Vérification réelle : le cookie doit ouvrir /api/models.
    const verified = await verifyCookie({ page, cfg, log }).catch(() => false);

    log.log(
      `[cf] cookies obtenus en ${Date.now() - startedAt} ms (${cookies.length} cookies, vérifiés: ${verified ? "oui" : "non"})`
    );

    return {
      cookieHeader,
      cookies,
      userAgent: cfg.userAgent,
      verified,
      obtainedAt: Date.now(),
      elapsedMs: Date.now() - startedAt,
      title,
    };
  } finally {
    await browser?.close().catch(() => {});
  }
}

/** Attend l'apparition du cookie cf_clearance (ou l'absence de challenge). */
async function waitForClearance({ page, context, cfg, log, startedAt }) {
  const deadline = startedAt + cfg.solver.timeoutMs;
  let clickedTurnstile = false;

  while (Date.now() < deadline) {
    const cookies = await context.cookies(cfg.baseUrl);
    if (cookies.some((c) => c.name === "cf_clearance")) return cookies;
    if (page.url() !== "about:blank" && !/challenge|cdn-cgi/i.test(page.url())) {
      // Le challenge s'est peut-être résolu via __cf_bm seulement.
      if (cookies.length > 0) return cookies;
    }

    // Tentative unique de clic sur la case Turnstile (utile en mode
    // « managed challenge » non chiffré).
    if (!clickedTurnstile) {
      clickedTurnstile = await clickTurnstile(page).catch(() => false);
      if (clickedTurnstile) log.log("[cf] case Turnstile cliquée, attente de la validation…");
    }

    await page.waitForTimeout(1000).catch(() => {});
  }
  return [];
}

/** Tente de cocher la case Turnstile dans l'iframe de challenge. */
async function clickTurnstile(page) {
  for (const frame of page.frames()) {
    if (!/challenges\.cloudflare\.com/.test(frame.url())) continue;
    for (const selector of ["input[type=checkbox]", "label", "#challenge-stage"]) {
      const locator = frame.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        await locator.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

/** Le challenge impose-t-il un Turnstile interactif ? */
async function hasTurnstile(page) {
  try {
    return page.frames().some((frame) => /challenges\.cloudflare\.com/.test(frame.url()));
  } catch {
    return false;
  }
}

/**
 * Vérifie le cookie en appelant /api/models DEPUIS la page (même contexte
 * navigateur, donc même empreinte TLS que le challenge).
 */
async function verifyCookie({ page, cfg }) {
  const result = await page.evaluate(async (baseUrl) => {
    try {
      const res = await fetch(`${baseUrl}/api/models`, {
        credentials: "include",
        headers: { accept: "application/json, text/plain, */*" },
      });
      const text = await res.text();
      let count = 0;
      try {
        count = Array.isArray(JSON.parse(text)?.data) ? JSON.parse(text).data.length : 0;
      } catch {
        /* réponse non JSON ignorée */
      }
      return { status: res.status, count };
    } catch (error) {
      return { status: 0, error: String(error?.message || error) };
    }
  }, cfg.baseUrl);

  return result?.status === 200;
}

/**
 * Sérialise des cookies Playwright en en-tête `Cookie`.
 * Les cookies httpOnly restent lisibles ici : Playwright les expose à
 * l'automate (c'est justement ce qui permet de rejouer la session).
 */
export function cookiesToHeader(cookies = []) {
  return cookies
    .filter((c) => c && typeof c.name === "string" && typeof c.value === "string")
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Ne garde que les cookies utiles à la passerelle. */
export function relevantCookies(cookies = []) {
  return cookies.filter((c) => /^(cf_|__cf)/.test(c.name));
}
