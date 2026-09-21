#!/usr/bin/env node
// vercel-env.mjs — pousse un fichier .env vers un projet Vercel.
//
// Pourquoi ce script ? `render.yaml` décrit les variables d'un service Render,
// mais Vercel n'a pas d'équivalent : le fichier `vercel.json` ne porte que la
// configuration de build/routing (le champ `env` y est un héritage déconseillé
// pour les secrets), et `vercel env` ne sait que les ajouter une par une.
// D'où ce petit pousseur : un fichier lisible et versionnable en modèle
// (`.env.vercel.example`), une commande pour l'envoyer.
//
//   npm run vercel:env                     # .env.vercel → production, preview, development
//   npm run vercel:env -- --dry            # aperçu, aucune modification
//   node scripts/vercel-env.mjs .env.vercel production
//   node scripts/vercel-env.mjs --file .env.vercel --env production --env preview
//
// Prérequis : CLI Vercel installée (`npm i -g vercel`) et projet lié
// (`vercel link`). Sans CLI, le script affiche les paires à coller dans le
// dashboard Vercel (Settings → Environment Variables).

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseDotEnv } from "../lib/env.js";

const DEFAULT_FILE = ".env.vercel";
const FALLBACK_FILE = ".env.vercel.example";
const DEFAULT_ENVS = ["production", "preview", "development"];

/** Clés considérées comme sensibles (valeur masquée dans l'aperçu). */
const SECRET_RE = /(TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|_KEY$|APIKEY)/i;

/** Variables imposées par la plateforme : jamais poussées. */
const IGNORED_KEYS = new Set(["VERCEL", "VERCEL_ENV", "VERCEL_URL", "PORT", "HOST"]);

export function isSecretKey(key) {
  return SECRET_RE.test(key);
}

/** Masque une valeur pour l'aperçu : jamais de secret en clair dans un terminal partagé. */
export function maskValue(key, value) {
  if (!isSecretKey(key)) return value;
  if (!value) return "(vide)";
  return `${value.slice(0, 4)}…${"*".repeat(Math.max(3, Math.min(12, value.length - 4)))}`;
}

/**
 * Construit le plan de poussée à partir du contenu d'un fichier .env.
 * @returns {{entries: Array<{key:string, value:string, secret:boolean}>, skipped: Array<{key:string, reason:string}>}}
 */
export function buildPushPlan(text) {
  const parsed = parseDotEnv(text);
  const entries = [];
  const skipped = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (IGNORED_KEYS.has(key)) {
      skipped.push({ key, reason: "imposée par la plateforme Vercel" });
      continue;
    }
    if (!value) {
      skipped.push({ key, reason: "valeur vide (laisser la variable absente)" });
      continue;
    }
    entries.push({ key, value, secret: isSecretKey(key) });
  }
  return { entries, skipped };
}

/* -------------------------------------------------------------------------- */
/* Exécution                                                                  */
/* -------------------------------------------------------------------------- */

function parseArgs(argv) {
  const options = { file: null, envs: [], dry: false, yes: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry" || arg === "--dry-run") options.dry = true;
    else if (arg === "--yes" || arg === "-y") options.yes = true;
    else if (arg === "--file") options.file = argv[++i];
    else if (arg === "--env") options.envs.push(argv[++i]);
    else if (!arg.startsWith("-") && !options.file) options.file = arg;
    else if (!arg.startsWith("-")) options.envs.push(arg);
  }
  if (!options.file) {
    options.file = existsSync(DEFAULT_FILE) ? DEFAULT_FILE : FALLBACK_FILE;
  }
  if (!options.envs.length) options.envs = [...DEFAULT_ENVS];
  return options;
}

function vercelAvailable() {
  const probe = spawnSync("vercel", ["--version"], { encoding: "utf8" });
  return probe.status === 0;
}

/** Affiche les commandes à copier-coller (mode manuel / dashboard). */
function printManualInstructions(entries, envs) {
  console.log("\nÀ renseigner dans le dashboard Vercel (Project → Settings → Environment Variables) :\n");
  for (const entry of entries) {
    console.log(`  ${entry.key} = ${maskValue(entry.key, entry.value)}${entry.secret ? "   (secret)" : ""}`);
  }
  console.log(`\nEnvironnements concernés : ${envs.join(", ")}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!existsSync(options.file)) {
    console.error(`✖ Fichier introuvable : ${options.file}`);
    console.error(`  Copiez ${FALLBACK_FILE} en ${DEFAULT_FILE}, remplissez-le, puis relancez.`);
    process.exitCode = 1;
    return;
  }

  const { entries, skipped } = buildPushPlan(readFileSync(options.file, "utf8"));

  console.log(`Venice — variables Vercel depuis ${options.file}`);
  console.log(`   environnements : ${options.envs.join(", ")}`);
  console.log(`   variables      : ${entries.length} à pousser, ${skipped.length} ignorées`);

  for (const item of skipped) console.log(`   · ignorée : ${item.key} (${item.reason})`);
  for (const entry of entries) {
    console.log(`   · ${entry.key} = ${maskValue(entry.key, entry.value)}${entry.secret ? "  [secret]" : ""}`);
  }

  if (options.dry) {
    console.log("\n(--dry) Aucune modification effectuée.");
    return;
  }

  if (!vercelAvailable()) {
    console.warn("\n⚠ CLI Vercel introuvable : npm i -g vercel, puis `vercel login` et `vercel link`.");
    printManualInstructions(entries, options.envs);
    return;
  }

  let failures = 0;
  for (const entry of entries) {
    for (const env of options.envs) {
      // La valeur passe par stdin : elle n'apparaît ni dans l'historique du
      // shell, ni dans `ps`. `--force` écrase une variable existante.
      const args = ["env", "add", entry.key, env, "--force"];
      if (options.yes) args.push("--yes");
      const res = spawnSync("vercel", args, { input: entry.value, encoding: "utf8" });
      if (res.status === 0) {
        console.log(`   ✓ ${entry.key} → ${env}`);
      } else {
        failures += 1;
        console.error(`   ✖ ${entry.key} → ${env} : ${(res.stderr || res.stdout || "").trim().split("\n").pop()}`);
      }
    }
  }

  if (failures) {
    console.error(`\n${failures} poussée(s) en échec. Lancez \`vercel link\` si le projet n'est pas lié.`);
    process.exitCode = 1;
    return;
  }
  console.log("\n✅ Terminé. Redéployez pour que les variables soient prises en compte : vercel --prod");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
