// ratelimit.js — limitation de débit en mémoire (fenêtre glissante).
//
// Objectif : rester un client « raisonnable » pour chat.dphn.ai (le brief
// insiste là-dessus) et protéger la passerelle d'un usage abusif. Une seule
// instance Render = une seule mémoire, ce qui suffit largement ici.

export function createRateLimiter({ limit = 30, windowMs = 60_000, now = () => Date.now() } = {}) {
  /** @type {Map<string, number[]>} clé → horodatages des requêtes */
  const hits = new Map();
  let lastSweep = now();

  function sweep() {
    const cutoff = now() - windowMs;
    for (const [key, stamps] of hits) {
      const kept = stamps.filter((stamp) => stamp > cutoff);
      if (kept.length) hits.set(key, kept);
      else hits.delete(key);
    }
    lastSweep = now();
  }

  return {
    enabled: limit > 0,

    /** @returns {{ok:boolean, remaining:number, retryAfterSec:number}} */
    check(key) {
      if (limit <= 0) return { ok: true, remaining: Infinity, retryAfterSec: 0 };
      const cutoff = now() - windowMs;
      if (now() - lastSweep > windowMs) sweep();

      const stamps = (hits.get(key) ?? []).filter((stamp) => stamp > cutoff);
      if (stamps.length >= limit) {
        const retryAfterMs = Math.max(0, stamps[0] + windowMs - now());
        hits.set(key, stamps);
        return { ok: false, remaining: 0, retryAfterSec: Math.ceil(retryAfterMs / 1000) };
      }
      stamps.push(now());
      hits.set(key, stamps);
      return { ok: true, remaining: limit - stamps.length, retryAfterSec: 0 };
    },

    reset() {
      hits.clear();
    },

    get size() {
      return hits.size;
    },
  };
}

/** Identifiant client (IP) — derrière Render, l'IP réelle est dans X-Forwarded-For. */
export function clientKey(req, { trustProxy = true } = {}) {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      return forwarded.split(",")[0].trim();
    }
  }
  return req.socket?.remoteAddress || "unknown";
}
