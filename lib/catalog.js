// catalog.js — cache du catalogue Dolphin (modèles + rôles).
//
// Le catalogue est lu en direct sur l'amont (source de vérité), mais il est
// mis en cache pour ne pas marteler le site : une requête toutes les
// `DOLPHIN_CATALOG_TTL_MS` (10 min par défaut). En cas d'échec amont, on sert
// le dernier catalogue connu ; à défaut, le catalogue de secours relevé sur
// le site officiel (src/catalog.js) — l'interface reste donc toujours
// utilisable, ce qui est le comportement attendu d'un produit.

import { buildCatalog, FALLBACK_CATALOG } from "../src/catalog.js";
import { fetchCatalog } from "./dolphin.js";

export function createCatalogService(cfg, session, deps = {}) {
  const load = deps.fetchCatalog ?? fetchCatalog;
  const log = deps.log ?? console;
  const now = deps.now ?? (() => Date.now());

  let cache = null; // { models, templates, source, fetchedAt, error }
  let inFlight = null;
  let failures = 0;
  let lastError = null;

  async function refresh(reason) {
    try {
      const { models, templates } = await load(cfg, session);
      cache = {
        ...buildCatalog({ models, templates, source: "live", fetchedAt: now() }),
        error: null,
      };
      failures = 0;
      lastError = null;
      log.log?.(
        `[catalog] rafraîchi (${reason}) : ${cache.models.length} modèles, ${cache.templates.length} rôles`
      );
      return cache;
    } catch (error) {
      failures += 1;
      lastError = error?.message || String(error);
      log.warn?.(`[catalog] lecture impossible : ${lastError}`);
      if (cache) {
        cache = { ...cache, error: lastError };
        return cache;
      }
      cache = {
        ...FALLBACK_CATALOG,
        error: lastError,
        fetchedAt: now(),
      };
      return cache;
    }
  }

  return {
    /** Catalogue courant (cache si frais, sinon rafraîchissement). */
    async get({ force = false } = {}) {
      const fresh = cache && now() - cache.fetchedAt < cfg.catalogTtlMs;
      if (fresh && !force) return cache;
      if (inFlight) return inFlight;
      inFlight = refresh(force ? "force" : "ttl").finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /** Catalogue déjà en mémoire, sans I/O (permet de valider un payload). */
    peek() {
      return cache;
    },

    status() {
      return {
        cached: Boolean(cache),
        source: cache?.source ?? "none",
        models: cache?.models.length ?? 0,
        templates: cache?.templates.length ?? 0,
        fetchedAt: cache?.fetchedAt ?? null,
        ageMs: cache ? now() - cache.fetchedAt : null,
        failures,
        lastError,
        refreshing: Boolean(inFlight),
      };
    },
  };
}

/** Identifiants utilisables pour valider une requête de chat. */
export function catalogIds(catalog) {
  if (!catalog) return { models: [], templates: [] };
  return {
    models: catalog.models.map((model) => model.id),
    templates: catalog.templates.map((template) => template.id),
  };
}
