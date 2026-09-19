// runtime.js — assemblage des briques de la passerelle.
//
// Un « runtime » = la configuration + la session Cloudflare + le cache du
// catalogue + le limiteur de débit. Il est construit une fois au démarrage et
// partagé par toutes les requêtes HTTP. Les tests injectent leurs propres
// dépendances (faux solveur, faux fetch amont) en passant un `overrides`.

import { getConfig } from "./config.js";
import { DolphinSession } from "./session.js";
import { createCatalogService } from "./catalog.js";
import { createRateLimiter } from "./ratelimit.js";

export function createRuntime(env = process.env, overrides = {}) {
  const cfg = overrides.cfg ?? getConfig(env);

  const session =
    overrides.session ??
    new DolphinSession(cfg, {
      solver: overrides.solver,
      log: overrides.log,
    });

  const catalog =
    overrides.catalog ??
    createCatalogService(cfg, session, {
      fetchCatalog: overrides.fetchCatalog,
      log: overrides.log,
    });

  const limiter =
    overrides.limiter ??
    createRateLimiter({ limit: cfg.rateLimit, windowMs: cfg.rateWindowMs, now: overrides.now });

  return {
    cfg,
    session,
    catalog,
    limiter,
    startedAt: Date.now(),
    /** Stream de démo (mode DEMO_MODE=1). */
    demo: cfg.demoMode,
  };
}
