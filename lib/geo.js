// lib/geo.js — Géolocalisation approximative d'une IP (panneau d'administration).
//
// À l'inscription, Venice enregistre l'adresse IP de l'utilisateur ainsi que
// sa localisation approximative (ville, région, pays). Ces données sont FIXES
// : capturées une seule fois à l'inscription et affichées uniquement dans le
// tableau des utilisateurs du panneau admin (/admin).
//
// Principes :
//   • L'inscription n'est JAMAIS bloquée : en cas d'échec (API injoignable,
//     timeout, IP privée), l'IP est quand même enregistrée avec
//     localisation = null.
//   • Zéro dépendance : fetch natif (Node ≥ 20).
//   • Cache mémoire de 7 jours : la même IP n'est pas re-queryée à chaque
//     inscription (préserve les quotas gratuits des fournisseurs).
//   • Trois fournisseurs gratuits, essayés dans l'ordre jusqu'au premier
//     succès : ipapi.co → ip-api.com → freegeoip.app.
//   • Les IP privées/locales (127.x, 10.x, 192.168.x, ::1, …) ne sont JAMAIS
//     envoyées vers un API externe.

const GEO_TIMEOUT_MS = 6000; // délai max PAR fournisseur (l'ensemble est plafonné)
const GEO_CACHE_TTL_MS = 7 * 86_400_000; // 7 jours
const GEO_CACHE_MAX = 5000;

const geoCache = new Map(); // ip → { at, location, countryCode }

/**
 * La géolocalisation est activée par défaut.
 * Désactivation : VENICE_IP_GEO=0 (l'IP est alors quand même enregistrée).
 */
export function isGeoEnabled(env = process.env) {
  const raw = String(env.VENICE_IP_GEO ?? "").trim().toLowerCase();
  if (!raw) return true;
  return !/^(0|false|no|off|disable[d]?)$/.test(raw);
}

/** Détecte les IP privées / locales (à ne jamais envoyer à un API externe). */
export function isPrivateIp(ip) {
  if (!ip) return true;
  const raw = String(ip).trim();
  if (!raw) return true;

  // --- IPv6 ---
  if (raw.includes(":")) {
    const lower = raw.toLowerCase().replace(/^\[|\]$/g, "");
    if (lower === "::1" || lower === "::") return true; // boucle / non routable
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    // IPv4 embeddé ::ffff:a.b.c.d
    const mapped = lower.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }

  // --- IPv4 ---
  const parts = raw.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // format inconnu : on traite comme privée par prudence
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGN)
  if (a === 127) return true; // 127.0.0.0/8
  if (a === 169 && b === 254) return true; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  return false;
}

/** GET JSON avec timeout (ne lève que sur échec). */
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Concatène les parties non vides en évitant les doublons ("New York, New York"). */
function buildLocation(parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const p = String(part || "").trim();
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out.join(", ");
}

/**
 * Résout la localisation approximative d'une IP.
 * Ne lève JAMAIS d'exception : retourne toujours
 *   { ip: string|null, location: string|null, countryCode: string|null }
 */
export async function locateIp(ip, { enabled = true, timeoutMs = GEO_TIMEOUT_MS, log = console } = {}) {
  const cleanIp = String(ip || "").trim();
  const none = { ip: cleanIp || null, location: null, countryCode: null };

  if (!enabled || !cleanIp || cleanIp === "unknown") return none;
  if (isPrivateIp(cleanIp)) {
    return { ip: cleanIp, location: "Local", countryCode: null };
  }

  const cached = geoCache.get(cleanIp);
  if (cached && Date.now() - cached.at < GEO_CACHE_TTL_MS) {
    return { ip: cleanIp, location: cached.location, countryCode: cached.countryCode };
  }

  const providers = [
    {
      name: "ipapi.co",
      url: `https://ipapi.co/${encodeURIComponent(cleanIp)}/json/`,
      parse(data) {
        if (!data || data.success === false) throw new Error("réponse refusée");
        return {
          city: data.city,
          region: data.region,
          country: data.country_name,
          countryCode: data.country_code,
        };
      },
    },
    {
      name: "ip-api.com",
      url: `https://ip-api.com/json/${encodeURIComponent(cleanIp)}?fields=status,city,regionName,country,countryCode`,
      parse(data) {
        if (!data || data.status !== "success") throw new Error("status !== success");
        return {
          city: data.city,
          region: data.regionName,
          country: data.country,
          countryCode: data.countryCode,
        };
      },
    },
    {
      name: "freegeoip.app",
      url: `https://freegeoip.app/json/${encodeURIComponent(cleanIp)}`,
      parse(data) {
        if (!data) throw new Error("réponse vide");
        return {
          city: data.city,
          region: data.region_name,
          country: null,
          countryCode: data.country_code,
        };
      },
    },
  ];

  for (const provider of providers) {
    try {
      const data = await fetchJson(provider.url, timeoutMs);
      const parsed = provider.parse(data);
      const location = buildLocation([parsed.city, parsed.region, parsed.country]);
      const countryCode = String(parsed.countryCode || "").trim().toUpperCase() || null;
      if (!location && !countryCode) throw new Error("aucune donnée de localisation");

      if (geoCache.size >= GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value);
      geoCache.set(cleanIp, { at: Date.now(), location: location || null, countryCode });
      return { ip: cleanIp, location: location || null, countryCode };
    } catch (err) {
      // Provenance suivante — un échec ne doit jamais bloquer l'inscription.
      log?.warn?.(`[geo] ${provider.name} indisponible pour ${cleanIp} : ${err.message}`);
    }
  }

  return { ip: cleanIp, location: null, countryCode: null };
}
