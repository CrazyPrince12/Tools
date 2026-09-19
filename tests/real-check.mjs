// real-check.mjs — test RÉEL contre le chat officiel Dolphin.
//
//   npm run test:real
//
// Prérequis :
//   • accès Internet sortant vers https://chat.dphn.ai
//   • Chromium installé pour Playwright (`npx playwright install --with-deps chromium`)
//     — inutile si DOLPHIN_COOKIE contient déjà un cookie valide.
//
// Ce script vérifie, dans l'ordre :
//   1. le challenge Cloudflare (réponse 403 `cf-mitigated: challenge` sans cookie) ;
//   2. la résolution du challenge et la récupération des cookies ;
//   3. GET /api/models et /api/templates avec ces cookies ;
//   4. POST /api/chat en SSE et les premiers tokens reçus.
//
// Chaque étape affiche OK / ÉCHEC ; le script sort en code 1 au premier échec.

import { loadDotEnv } from "../lib/env.js";
import { getConfig } from "../lib/config.js";
import { DolphinSession } from "../lib/session.js";
import { fetchCatalog, streamChat, upstreamFetch } from "../lib/dolphin.js";
import { parseCookieHeader } from "../lib/session.js";

loadDotEnv();

const log = console;
const results = [];

function report(step, ok, info = "") {
  results.push({ step, ok, info });
  console.log(`${ok ? "  OK  " : " ÉCHEC"}  ${step}${info ? ` — ${info}` : ""}`);
}

async function main() {
  const cfg = getConfig();
  console.log(`\nVenice · test réel — cible ${cfg.baseUrl}`);
  console.log(`solveur : ${cfg.solver.mode} (${cfg.solver.module}) · cookie manuel : ${cfg.cookie ? "oui" : "non"}\n`);

  // 1. Challenge sans cookie -------------------------------------------------
  try {
    const res = await fetch(`${cfg.baseUrl}/api/models`, {
      headers: { "user-agent": cfg.userAgent, accept: "application/json, */*" },
    });
    const mitigated = res.headers.get("cf-mitigated");
    report(
      "challenge Cloudflare sans cookie",
      res.status === 403 || res.status === 401 || res.status === 503,
      `HTTP ${res.status}${mitigated ? ` · cf-mitigated: ${mitigated}` : ""}`
    );
  } catch (error) {
    report("challenge Cloudflare sans cookie", false, error.message);
    return finish();
  }

  // 2. Résolution du challenge ----------------------------------------------
  const session = new DolphinSession(cfg, {
    log: silent(),
  });
  try {
    const cookie = await session.ensureFresh({ force: true, reason: "real-check" });
    const names = cookie
      .split(";")
      .map((part) => part.trim().split("=")[0])
      .filter(Boolean);
    report("résolution du challenge", names.includes("cf_clearance"), `cookies : ${names.join(", ") || "aucun"}`);
  } catch (error) {
    report("résolution du challenge", false, error.message);
    return finish();
  }

  // 3. Catalogue -------------------------------------------------------------
  let catalog = null;
  try {
    catalog = await fetchCatalog(cfg, session);
    report(
      "GET /api/models + /api/templates",
      catalog.models.length > 0 && catalog.templates.length > 0,
      `${catalog.models.length} modèles, ${catalog.templates.length} rôles`
    );
  } catch (error) {
    report("GET /api/models + /api/templates", false, error.message);
    return finish();
  }

  // 4. Chat en streaming -----------------------------------------------------
  try {
    const model = catalog.models[0].id;
    const template = catalog.templates[0].name ?? catalog.templates[0].id;
    const started = Date.now();
    let text = "";
    let firstTokenAt = null;

    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(), 60_000);

    for await (const delta of streamChat({
      cfg,
      session,
      payload: {
        messages: [{ role: "user", content: "Réponds simplement : bonjour." }],
        model,
        template,
        systemPrompt: cfg.systemPrompt,
        instructions: undefined,
      },
      signal: controller.signal,
      log: silent(),
    })) {
      if (firstTokenAt === null) firstTokenAt = Date.now() - started;
      text += delta;
      if (text.length > 400) break;
    }
    clearTimeout(watchdog);

    report(
      "POST /api/chat en SSE",
      text.trim().length > 0,
      `premier token en ${firstTokenAt} ms · ${text.trim().length} caractères reçus`
    );
    console.log(`\n--- extrait de la réponse ---\n${text.trim().slice(0, 300)}\n-----------------------------\n`);
  } catch (error) {
    report("POST /api/chat en SSE", false, error.message);
  }

  finish();
}

function silent() {
  return { log() {}, warn() {}, error() {} };
}

function finish() {
  const failed = results.filter((result) => !result.ok).length;
  const cookie = results.find((r) => r.step.includes("résolution"))?.info ?? "";
  console.log(`\n${results.length - failed}/${results.length} étapes réussies.`);
  if (cookie) {
    console.log(
      `Astuce : pour figer la session, recopiez le cookie dans DOLPHIN_COOKIE (il expirera de toute façon en ~30 min).`
    );
  }
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error("Erreur inattendue :", error);
  process.exit(1);
});
