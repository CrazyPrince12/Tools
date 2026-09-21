// server.js — serveur Node natif (zéro framework HTTP).
//
//   • sert le frontend statique (public/)
//   • expose l'API de la passerelle (lib/httpApi.js) :
//       POST /api/chat · GET /api/models · GET /api/templates
//       GET /api/catalog · GET /api/health · POST /api/session/refresh
//   • démarre la boucle de rafraîchissement du cookie Cloudflare
//
// C'est le point d'entrée utilisé en local, dans la preview sandbox, sur
// Render (runtime Docker ou Node) et dans n'importe quel conteneur.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "./lib/env.js";
import { getConfig } from "./lib/config.js";
import { createRuntime } from "./lib/runtime.js";
import {
  applyCors,
  handleCatalogHttp,
  handleChatHttp,
  handleHealthHttp,
  handleSessionRefresh,
  sendJson,
} from "./lib/httpApi.js";

loadDotEnv(); // .env local (ignoré par git) — no-op si absent

const PUBLIC_DIR = fileURLToPath(new URL("./public", import.meta.url));
const SECONDS = { html: 0, asset: 60 * 60 * 24 * 7 };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * En-têtes appliqués à toutes les réponses.
 * ⚠️ Volontairement AUCUN `X-Frame-Options` ni `frame-ancestors` : Venice doit
 * pouvoir être affichée dans l'aperçu embarqué (iframe) de la plateforme.
 */
function securityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
}

/* -------------------------------------------------------------------------- */
/* Fichiers statiques                                                         */
/* -------------------------------------------------------------------------- */

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");

  // Protection contre la traversée de répertoires.
  const filePath = normalize(join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 403, { error: { status: 403, message: "Accès interdit." } });
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");

    const ext = extname(filePath).toLowerCase();
    const isHtml = ext === ".html";
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": info.size,
      "Cache-Control": isHtml
        ? "no-cache"
        : `public, max-age=${SECONDS.asset}, immutable`,
      "Last-Modified": info.mtime.toUTCString(),
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(await readFile(filePath));
  } catch {
    // Repli SPA : toute route inconnue (sans extension) rend l'index.
    if (!extname(rel)) {
      try {
        const html = await readFile(join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
        res.end(html);
        return;
      } catch {
        /* passe au 404 */
      }
    }
    sendJson(res, 404, { error: { status: 404, message: "Ressource introuvable." } });
  }
}

/* -------------------------------------------------------------------------- */
/* Application                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Construit le handler HTTP. Exporté pour les tests (on peut injecter un
 * runtime avec un faux solveur et un faux amont).
 */
export function createApp(env = process.env, runtime = createRuntime(env)) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    securityHeaders(res);

    try {
      // CORS : uniquement si l'interface est servie depuis un autre domaine
      // que la passerelle (VENICE_ALLOWED_ORIGINS). No-op par défaut.
      if (applyCors(req, res, runtime.cfg)) return;

      if (pathname === "/api/chat" || pathname === "/api/chat/") {
        await handleChatHttp(req, res, runtime);
        return;
      }
      if (pathname === "/api/models" || pathname === "/api/models/") {
        await handleCatalogHttp(req, res, runtime, "models");
        return;
      }
      if (pathname === "/api/templates" || pathname === "/api/templates/") {
        await handleCatalogHttp(req, res, runtime, "templates");
        return;
      }
      if (pathname === "/api/catalog" || pathname === "/api/catalog/") {
        await handleCatalogHttp(req, res, runtime, "catalog");
        return;
      }
      if (pathname === "/api/health" || pathname === "/api/health/") {
        handleHealthHttp(req, res, runtime, { scraper: "chat.dphn.ai" });
        return;
      }
      if (pathname === "/api/session/refresh") {
        await handleSessionRefresh(req, res, runtime);
        return;
      }
      if (pathname.startsWith("/api/")) {
        sendJson(res, 404, {
          error: { status: 404, message: `Route inconnue : ${pathname}` },
        });
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, {
          error: { status: 405, message: "Méthode non autorisée." },
        });
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (error) {
      console.error("[server] erreur inattendue :", error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: { status: 500, message: "Erreur interne du serveur." } });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.runtime = runtime;
  return server;
}

/** Démarre le serveur + la boucle de session Cloudflare. */
export function startServer(env = process.env) {
  const cfg = getConfig(env);
  const runtime = createRuntime(env);
  const server = createApp(env, runtime);

  // Boucle de rafraîchissement du cookie cf_clearance (tâche de fond).
  //
  // ⚠️ Sur une plateforme « serverless » (Vercel, Netlify, Lambda), elle n'a
  // aucun sens : chaque invocation est un processus neuf, parallèle, sans
  // navigateur, et l'IP de sortie change — or `cf_clearance` est lié à l'IP.
  // On la désactive et on le dit clairement au démarrage.
  if (cfg.platform.serverless) {
    console.warn(
      `[server] ${cfg.platform.label} détecté : aucune session Cloudflare persistante possible (pas de Chromium, IP de sortie instable).`
    );
    console.warn(
      `[server] → servez l'interface ici (statique) et hébergez la passerelle sur un conteneur (Render, Docker, Fly.io). Voir « Déploiement Vercel » dans le README.`
    );
  } else {
    runtime.session.start();
    if (cfg.refreshOnBoot && !cfg.demoMode) runtime.session.prewarm();
  }

  server.listen(cfg.port, cfg.host, () => {
    const mode = cfg.demoMode ? "DÉMO (réponses simulées)" : "LIVE (chat.dphn.ai)";
    console.log(`${cfg.app.name} v${cfg.app.version} — ${cfg.app.tagline}`);
    console.log(`   écoute      : http://${cfg.host}:${cfg.port}`);
    console.log(`   mode        : ${mode}`);
    console.log(`   plateforme  : ${cfg.platform.label}${cfg.platform.serverless ? " (serverless — pas de session CF possible)" : ""}`);
    console.log(`   amont       : ${cfg.baseUrl}`);
    console.log(
      `   solveur CF  : ${cfg.solver.mode === "none" ? "désactivé" : `Playwright (${cfg.solver.module}, headless=${cfg.solver.headless})`}`
    );
    console.log(
      `   session     : ${runtime.session.hasCookie ? `cookie ${cfg.cookie ? "manuel" : "préchargé"}` : "vide (résolution au premier appel)"}`
    );
    console.log(
      `   garde-fous  : ${cfg.rateLimit > 0 ? `${cfg.rateLimit} req/min/IP` : "débit illimité"} · cookies rafraîchis toutes les ${Math.round(cfg.refreshIntervalMs / 60000)} min`
    );
  });

  const shutdown = (signal) => {
    console.log(`\n[server] ${signal} reçu — arrêt propre.`);
    runtime.session.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Une erreur de la boucle de session ne doit jamais tuer le serveur.
  process.on("unhandledRejection", (reason) => {
    console.warn("[server] promesse rejetée non gérée :", reason?.message || reason);
  });

  return server;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) startServer();
