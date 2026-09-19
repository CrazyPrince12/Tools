// Chargement minimaliste d'un fichier .env (zéro dépendance).
// Utilisé par server.js en local / sur Render. Les plateformes qui injectent
// déjà les variables d'environnement (Render, Docker, Arena) n'en ont pas
// besoin : si le fichier est absent, la fonction ne fait rien.

import { readFileSync } from "node:fs";

/**
 * Parse le contenu d'un fichier .env.
 * Gère : commentaires (#), lignes vides, quotes simples/doubles, valeur
 * contenant "=", fin de ligne CRLF.
 */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Charge .env dans process.env sans écraser les variables déjà définies.
 * Ne lève pas d'erreur si le fichier est absent.
 */
export function loadDotEnv(path = ".env") {
  try {
    const parsed = parseDotEnv(readFileSync(path, "utf8"));
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
    return true;
  } catch {
    return false;
  }
}
