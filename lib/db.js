// lib/db.js — Gestionnaire de base de données PostgreSQL Neon avec filet de sécurité local.
//
// ⚠️ RÈGLE D'OR : la source de vérité est la base Neon PostgreSQL externe
// (variable DATABASE_URL). Contrairement au disque éphémère de Render, elle
// SURVIT aux déploiements, aux merges de PR, aux commits et même à la
// suppression/recréation du service Render : les comptes et les sessions ne
// peuvent plus disparaître après un déploiement.
//
// Stratégie "zéro perte" :
//   1. Au démarrage, la connexion à Neon est retentée plusieurs fois (backoff)
//      — un simple cold-start lent de Neon ne fait plus basculer le serveur en
//      mode fichier local.
//   2. Si Neon est vraiment injoignable, le serveur continue de fonctionner en
//      MODE DÉGRADÉ sur un store local (utile en dev / sandbox), avec une
//      boucle de reconnexion automatique.
//   3. Dès que Neon redevient joignable, tout ce qui a été créé en mode
//      dégradé (utilisateurs, sessions, messages) est SYNCHRONISÉ vers Neon
//      (upsert sans écrasement) avant de rebasculer dessus. Rien n'est perdu.
//
// Les sessions (90 jours, glissantes) vivent dans la base : elles survivent
// donc elles aussi aux redéploiements.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import bcrypt from "bcryptjs";
import { locateIp, isGeoEnabled } from "./geo.js";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const LOCAL_DB_PATH = join(ROOT_DIR, "data", "venice_store.json");
const ADMIN_CREDS_PATH = join(ROOT_DIR, "admin-credentials.json");

/** Durée de vie des sessions (jours) et seuil de renouvellement glissant. */
export const SESSION_DAYS = 90;

let pool = null;
let usePostgres = false;
let hasDatabaseUrl = false;
let degraded = false; // DATABASE_URL configuré mais injoignable -> store local temporaire
let isInitialized = false;
let connectedAt = null;
let lastDbError = null;
let lastSyncAt = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

// Mémoire de secours si Postgres n'est pas joignable
let localStore = {
  users: [],
  sessions: [],
  messages: [],
  auditLogs: [],
};

const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EPIPE",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300", // too many connections
  "57P01", // admin shutdown
  "57P03", // cannot connect now
]);

function isConnectionError(err) {
  if (!err) return false;
  if (CONNECTION_ERROR_CODES.has(err.code)) return true;
  return /connection terminated|timeout expired|too many connections|server closed the connection|SSL connection|connection refused/i.test(
    String(err.message || "")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Décide si la connexion doit utiliser SSL :
 *   • oui par défaut (Neon et la plupart des bases managées l'exigent) ;
 *   • non pour un hôte local (Postgres de dev, tests) sauf sslmode explicite.
 */
function resolveSsl(databaseUrl) {
  try {
    const url = new URL(databaseUrl);
    const mode = (url.searchParams.get("sslmode") || "").toLowerCase();
    if (["require", "verify-ca", "verify-full"].includes(mode)) {
      return { rejectUnauthorized: false };
    }
    if (mode === "disable" || mode === "prefer" || mode === "allow") return undefined;
    const host = url.hostname;
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return undefined;
    return { rejectUnauthorized: false };
  } catch {
    return { rejectUnauthorized: false };
  }
}

function isProduction() {
  return process.env.NODE_ENV === "production" || Boolean(process.env.RENDER);
}

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/* -------------------------------------------------------------------------- */
/* Identifiants administrateur                                                */
/* -------------------------------------------------------------------------- */

/**
 * Identifiants du compte administrateur, resynchronisés à chaque démarrage.
 * Ordre de priorité : variables d'environnement (recommandé en production)
 * puis admin-credentials.json puis valeurs par défaut.
 */
export async function getAdminCredentials() {
  let creds = {
    username: "CrazyPrince",
    email: "francisvoufo@gmail.com",
    password: "CRAZY237",
  };
  try {
    if (existsSync(ADMIN_CREDS_PATH)) {
      const raw = await readFile(ADMIN_CREDS_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") creds = { ...creds, ...parsed };
    }
  } catch (err) {
    console.warn("[db] Impossible de lire admin-credentials.json :", err.message);
  }
  return {
    username: process.env.ADMIN_USERNAME || creds.username,
    email: process.env.ADMIN_EMAIL || creds.email,
    password: process.env.ADMIN_PASSWORD || creds.password,
  };
}

/* -------------------------------------------------------------------------- */
/* Store local (mode dégradé / dev)                                           */
/* -------------------------------------------------------------------------- */

/** Sauvegarde le store local sur disque */
async function saveLocalStore() {
  try {
    const dir = dirname(LOCAL_DB_PATH);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(LOCAL_DB_PATH, JSON.stringify(localStore, null, 2), "utf8");
  } catch (err) {
    console.error("[db] Erreur de sauvegarde du store local :", err.message);
  }
}

/** Charge le store local depuis le disque */
async function loadLocalStore() {
  try {
    if (existsSync(LOCAL_DB_PATH)) {
      const raw = await readFile(LOCAL_DB_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") localStore = parsed;
    }
  } catch (err) {
    console.warn("[db] Store local illisible, création d'un nouveau :", err.message);
  }
  if (!Array.isArray(localStore.users)) localStore.users = [];
  if (!Array.isArray(localStore.sessions)) localStore.sessions = [];
  if (!Array.isArray(localStore.messages)) localStore.messages = [];
  if (!Array.isArray(localStore.auditLogs)) localStore.auditLogs = [];
}

/* -------------------------------------------------------------------------- */
/* Connexion PostgreSQL (Neon)                                                */
/* -------------------------------------------------------------------------- */

/** Crée le schéma de tables PostgreSQL */
async function createPostgresTables() {
  const schema = `
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      pseudo TEXT NOT NULL,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      heard_from TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      alert_message TEXT,
      request_count INTEGER NOT NULL DEFAULT 0,
      token_count INTEGER NOT NULL DEFAULT 0,
      register_ip TEXT,
      location TEXT,
      country_code TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      last_login_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      conversation_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      template TEXT,
      tokens_estimate INTEGER NOT NULL DEFAULT 0,
      ip TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_user_id ON messages(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

    -- Migration : les bases existantes (déployées avant le suivi IP/localisation)
    -- obtiennent les nouvelles colonnes sans casser le schéma en place.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS register_ip TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS location TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS country_code TEXT;
  `;
  await q(schema);
}

/**
 * Tente de se connecter à Neon avec plusieurs essais (backoff exponentiel).
 * Un cold-start de Neon peut dépasser 5 s : un seul essai ne suffit pas.
 */
async function tryConnectPostgres(databaseUrl) {
  const maxAttempts = Math.max(1, envInt("DATABASE_CONNECT_RETRIES", 5));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: resolveSsl(databaseUrl),
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        max: 5, // le pooler Neon gratuit limite les connexions simultanées
        keepAlive: true,
      });

      const client = await pool.connect();
      client.release();

      // Le flag est basculé AVANT la création des tables : q() en dépend.
      usePostgres = true;
      degraded = false;

      await createPostgresTables();
      // Ménage : sessions expirées depuis plus de 7 jours.
      await q(`DELETE FROM sessions WHERE expires_at < NOW() - INTERVAL '7 days'`);

      connectedAt = new Date().toISOString();
      lastDbError = null;
      reconnectAttempts = 0;
      console.log("[db] ✅ Connecté à PostgreSQL (Neon) — persistance garantie.");
      return true;
    } catch (err) {
      lastDbError = err.message;
      console.warn(
        `[db] Connexion PostgreSQL ${attempt}/${maxAttempts} échouée : ${err.message}`
      );
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* noop */
        }
        pool = null;
      }
      if (attempt < maxAttempts) {
        const delay = Math.min(8_000, 500 * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
  }
  return false;
}

/** Bascule en mode dégradé (store local) et lance la boucle de reconnexion. */
function enterDegraded(err, { quiet = false } = {}) {
  const wasDegraded = degraded;
  usePostgres = false;
  degraded = true;
  lastDbError = err?.message || String(err || "inconnue");

  if (!quiet || !wasDegraded) {
    console.error("---------------------------------------------------------------------------");
    console.error("[db] ⚠️  MODE DÉGRADÉ : PostgreSQL est injoignable.");
    console.error(`[db]     Dernière erreur : ${lastDbError}`);
    console.error("[db]     Le serveur continue avec le store local ; dès que PostgreSQL");
    console.error("[db]     redevient joignable, les données locales y seront synchronisées");
    console.error("[db]     automatiquement (aucune perte de compte).");
    console.error("---------------------------------------------------------------------------");
  }
  startReconnectLoop();
}

/** Boucle de reconnexion : dès que Neon répond, on y rebascule. */
function startReconnectLoop() {
  if (reconnectTimer) return;
  const intervalMs = Math.max(5_000, envInt("DATABASE_RECONNECT_MS", 30_000));
  reconnectTimer = setInterval(async () => {
    if (usePostgres || !hasDatabaseUrl) {
      stopReconnectLoop();
      return;
    }
    reconnectAttempts += 1;
    console.log(`[db] Reconnexion à PostgreSQL… (essai ${reconnectAttempts})`);
    const ok = await tryConnectPostgres(process.env.DATABASE_URL);
    if (!ok) return;

    stopReconnectLoop();
    try {
      const counts = await syncLocalStoreToPostgres();
      const adminCreds = await getAdminCredentials();
      await ensureAdminUser(adminCreds);
      lastSyncAt = new Date().toISOString();
      console.log(
        `[db] ✅ Reconnexion réussie — synchronisation terminée : ` +
          `${counts.users} utilisateur(s), ${counts.sessions} session(s), ${counts.messages} message(s) récupérés depuis le mode dégradé.`
      );
    } catch (err) {
      console.error("[db] Synchronisation locale → PostgreSQL partiellement échouée :", err.message);
    }
  }, intervalMs);
  reconnectTimer.unref?.();
}

function stopReconnectLoop() {
  if (reconnectTimer) {
    clearInterval(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Wrapper de requête PostgreSQL : détecte les pertes de connexion en cours
 * d'exécution et repasse automatiquement en mode dégradé (avec reconnexion
 * programmée) au lieu de laisser le serveur dans un état cassé.
 */
async function q(text, params = []) {
  if (!pool || !usePostgres) {
    const err = new Error("PostgreSQL indisponible (mode dégradé actif).");
    err.dbUnavailable = true;
    throw err;
  }
  try {
    return await pool.query(text, params);
  } catch (err) {
    if (isConnectionError(err)) {
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* noop */
        }
        pool = null;
      }
      enterDegraded(err);
    }
    err.dbUnavailable = true;
    throw err;
  }
}

/**
 * Synchronisation montante : pousse dans PostgreSQL tout ce qui a été créé
 * pendant le mode dégradé. Les conflits (utilisateur/session/message déjà
 * présent) sont ignorés sans jamais écraser les données existantes.
 */
async function syncLocalStoreToPostgres() {
  const counts = { users: 0, sessions: 0, messages: 0 };

  for (const u of localStore.users) {
    try {
      await q(
        `INSERT INTO users (id, pseudo, username, email, heard_from, password_hash, role, status,
                            alert_message, request_count, token_count, created_at, last_login_at,
                            register_ip, location, country_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO NOTHING`,
        [
          u.id,
          u.pseudo,
          u.username,
          u.email,
          u.heard_from || "",
          u.password_hash,
          u.role || "user",
          u.status || "active",
          u.alert_message ?? null,
          u.request_count || 0,
          u.token_count || 0,
          u.created_at,
          u.last_login_at,
          u.register_ip ?? null,
          u.location ?? null,
          u.country_code ?? null,
        ]
      );
      counts.users += 1;
    } catch (err) {
      if (err.code === "23505") continue; // username/email déjà pris : on ignore
      throw err;
    }
  }

  for (const s of localStore.sessions) {
    if (new Date(s.expires_at) < new Date()) continue; // session expirée : inutile
    try {
      await q(
        `INSERT INTO sessions (token, user_id, expires_at, created_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (token) DO NOTHING`,
        [s.token, s.user_id, s.expires_at, s.created_at]
      );
      counts.sessions += 1;
    } catch {
      /* session déjà connue : on ignore */
    }
  }

  for (const m of localStore.messages) {
    try {
      await q(
        `INSERT INTO messages (id, user_id, username, conversation_id, role, content, model,
                               template, tokens_estimate, ip, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING`,
        [
          m.id,
          m.user_id,
          m.username,
          m.conversation_id ?? null,
          m.role,
          m.content,
          m.model ?? null,
          m.template ?? null,
          m.tokens_estimate || 0,
          m.ip || "",
          m.created_at,
        ]
      );
      counts.messages += 1;
    } catch {
      /* message déjà connu : on ignore */
    }
  }

  // Une fois synchronisés, on purge le tampon local pour repartir proprement.
  localStore = { users: [], sessions: [], messages: [], auditLogs: [] };
  await saveLocalStore();

  return counts;
}

/* -------------------------------------------------------------------------- */
/* Initialisation                                                             */
/* -------------------------------------------------------------------------- */

/** Initialise la base de données (PostgreSQL Neon ou store local). */
export async function initDb(databaseUrl = process.env.DATABASE_URL) {
  if (isInitialized) return getDbStatus();

  await loadLocalStore();
  hasDatabaseUrl = Boolean(databaseUrl);

  if (databaseUrl) {
    const ok = await tryConnectPostgres(databaseUrl);
    if (ok) {
      // Cas limite important : une instance précédente a tourné en mode
      // dégradé (base injoignable) et a laissé des données dans le tampon
      // local — par exemple après un redéploiement Render. On les pousse
      // immédiatement dans PostgreSQL pour ne rien perdre.
      const pending =
        localStore.users.length + localStore.sessions.length + localStore.messages.length;
      if (pending > 0) {
        try {
          const counts = await syncLocalStoreToPostgres();
          lastSyncAt = new Date().toISOString();
          console.log(
            `[db] ✅ Tampon local synchronisé vers PostgreSQL : ` +
              `${counts.users} utilisateur(s), ${counts.sessions} session(s), ${counts.messages} message(s).`
          );
        } catch (err) {
          console.error("[db] Synchronisation du tampon local échouée :", err.message);
        }
      }
    } else {
      enterDegraded({ message: lastDbError });
    }
  } else {
    usePostgres = false;
    if (isProduction()) {
      console.error("---------------------------------------------------------------------------");
      console.error("[db] ⚠️  DATABASE_URL EST ABSENT ALORS QUE LE SERVEUR TOURNE EN PRODUCTION.");
      console.error("[db]     Les comptes seront stockés dans un fichier local ÉPHÉMÈRE : ils");
      console.error("[db]     disparaîtront au prochain déploiement (disque Render non persistant).");
      console.error("[db]     → Définissez DATABASE_URL (Neon PostgreSQL) dans le dashboard Render.");
      console.error("---------------------------------------------------------------------------");
    } else {
      console.log("[db] Aucune DATABASE_URL fournie → store local (mode dev/sandbox).");
    }
  }

  // Synchronisation du compte admin (toujours garantit l'accès administrateur).
  const adminCreds = await getAdminCredentials();
  await ensureAdminUser(adminCreds);

  // Rattrapage non bloquant : les comptes créés AVANT le suivi IP obtiennent
  // leur IP d'inscription depuis leur premier message de chat (déjà journalisé)
  // puis leur localisation approximative (best effort, plafonné par démarrage).
  setImmediate(() => {
    backfillUserIpsAndLocations().catch((err) => {
      console.warn("[db] Rattrapage IP/localisation ignoré :", err.message);
    });
  });

  isInitialized = true;
  return getDbStatus();
}

/**
 * Rattrapage des utilisateurs existants (opération silencieuse : aucun champ
 * n'est modifié s'il est déjà renseigné — les données d'inscription restent
 * FIXES, l'IP n'est jamais écrasée par une IP ultérieure).
 */
async function backfillUserIpsAndLocations() {
  if (!usePostgres) return;

  // 1) IP d'inscription : IP du plus ancien message de chat de l'utilisateur.
  try {
    await q(`
      UPDATE users u
      SET register_ip = sub.ip
      FROM (
        SELECT DISTINCT ON (user_id) user_id, ip
        FROM messages
        WHERE ip IS NOT NULL AND TRIM(ip) <> ''
        ORDER BY user_id, created_at ASC
      ) sub
      WHERE u.id = sub.user_id
        AND u.register_ip IS NULL
    `);
  } catch (err) {
    console.warn("[db] Rattrapage des IP ignoré :", err.message);
    return;
  }

  // 2) Localisation : plafonné à 25 comptes par démarrage pour respecter les
  //    quotas gratuits des API (le solde sera traité au démarrage suivant).
  if (!isGeoEnabled(process.env)) return;
  try {
    const res = await q(`
      SELECT id, register_ip
      FROM users
      WHERE register_ip IS NOT NULL AND TRIM(register_ip) <> '' AND location IS NULL
      ORDER BY created_at ASC
      LIMIT 25
    `);
    for (const row of res.rows) {
      try {
        const geo = await locateIp(row.register_ip, { enabled: true });
        if (geo.location || geo.countryCode) {
          await q(`UPDATE users SET location = $1, country_code = $2 WHERE id = $3`, [
            geo.location,
            geo.countryCode,
            row.id,
          ]);
        }
      } catch {
        /* utilisateur suivant */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (err) {
    console.warn("[db] Rattrapage localisation ignoré :", err.message);
  }
}

/** État courant du stockage, exposé notamment via /api/health. */
export function getDbStatus() {
  return {
    mode: usePostgres ? "postgres" : degraded ? "local-degraded" : "local",
    postgres: usePostgres,
    degraded,
    hasDatabaseUrl,
    connectedAt,
    lastError: lastDbError,
    lastSyncAt,
    reconnectAttempts,
    localPath: LOCAL_DB_PATH,
  };
}

/* -------------------------------------------------------------------------- */
/* Compte administrateur                                                      */
/* -------------------------------------------------------------------------- */

/** Assure que l'utilisateur Admin existe avec les bons identifiants */
async function ensureAdminUser(adminCreds) {
  const hash = await bcrypt.hash(adminCreds.password, 10);
  const now = new Date().toISOString();

  if (usePostgres) {
    const res = await q(`SELECT * FROM users WHERE username = $1 OR email = $2 LIMIT 1`, [
      adminCreds.username,
      adminCreds.email,
    ]);

    if (res.rows.length === 0) {
      const id = "admin-" + randomUUID().slice(0, 8);
      await q(
        `INSERT INTO users (id, pseudo, username, email, heard_from, password_hash, role, status, created_at, last_login_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          adminCreds.username,
          adminCreds.username,
          adminCreds.email,
          "Fondateur Venice",
          hash,
          "admin",
          "active",
          now,
          now,
        ]
      );
      console.log(`[db] Compte administrateur créé : ${adminCreds.username}`);
    } else {
      // Mettre à jour le rôle et mot de passe pour garantir la conformité
      const existing = res.rows[0];
      await q(`UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2`, [
        hash,
        existing.id,
      ]);
    }
  } else {
    // Mode local
    let admin = localStore.users.find(
      (u) =>
        u.username.toLowerCase() === adminCreds.username.toLowerCase() ||
        u.email.toLowerCase() === adminCreds.email.toLowerCase()
    );

    if (!admin) {
      admin = {
        id: "admin-" + randomUUID().slice(0, 8),
        pseudo: adminCreds.username,
        username: adminCreds.username,
        email: adminCreds.email,
        heard_from: "Fondateur Venice",
        password_hash: hash,
        role: "admin",
        status: "active",
        alert_message: null,
        request_count: 0,
        token_count: 0,
        created_at: now,
        last_login_at: now,
      };
      localStore.users.push(admin);
      await saveLocalStore();
      console.log(`[db] Compte administrateur local créé : ${adminCreds.username}`);
    } else {
      admin.role = "admin";
      admin.password_hash = hash;
      await saveLocalStore();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Opérations Utilisateurs                                                    */
/* -------------------------------------------------------------------------- */

export async function findUserByUsernameOrEmail(identifier) {
  if (!identifier) return null;
  const clean = String(identifier).trim().toLowerCase();

  if (usePostgres) {
    const res = await q(
      `SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1`,
      [clean]
    );
    return res.rows[0] || null;
  }

  return (
    localStore.users.find(
      (u) => u.username.toLowerCase() === clean || u.email.toLowerCase() === clean
    ) || null
  );
}

export async function findUserById(id) {
  if (!id) return null;

  if (usePostgres) {
    const res = await q(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] || null;
  }

  return localStore.users.find((u) => u.id === id) || null;
}

export async function createUser({
  pseudo,
  username,
  email,
  heard_from,
  password,
  register_ip = null,
  location = null,
  country_code = null,
}) {
  const hash = await bcrypt.hash(password, 10);
  const id = randomUUID();
  const now = new Date().toISOString();

  if (usePostgres) {
    const res = await q(
      `INSERT INTO users (id, pseudo, username, email, heard_from, password_hash, role, status,
                          register_ip, location, country_code, created_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'user', 'active', $7, $8, $9, $10, $10)
       RETURNING *`,
      [
        id,
        pseudo,
        username,
        email,
        heard_from || "",
        hash,
        register_ip || null,
        location || null,
        country_code || null,
        now,
      ]
    );
    return res.rows[0];
  }

  const user = {
    id,
    pseudo,
    username,
    email,
    heard_from: heard_from || "",
    password_hash: hash,
    role: "user",
    status: "active",
    alert_message: null,
    request_count: 0,
    token_count: 0,
    register_ip: register_ip || null,
    location: location || null,
    country_code: country_code || null,
    created_at: now,
    last_login_at: now,
  };
  localStore.users.push(user);
  await saveLocalStore();
  return user;
}

export async function updateUserStatus(userId, status) {
  if (usePostgres) {
    await q(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
  } else {
    const u = localStore.users.find((x) => x.id === userId);
    if (u) {
      u.status = status;
      await saveLocalStore();
    }
  }
}

export async function updateUserAlert(userId, alertMessage) {
  const alert = alertMessage ? String(alertMessage).trim() : null;
  if (usePostgres) {
    await q(`UPDATE users SET alert_message = $1 WHERE id = $2`, [alert, userId]);
  } else {
    const u = localStore.users.find((x) => x.id === userId);
    if (u) {
      u.alert_message = alert;
      await saveLocalStore();
    }
  }
}

export async function recordUserActivity(userId, { tokens = 0 } = {}) {
  const now = new Date().toISOString();
  if (usePostgres) {
    await q(
      `UPDATE users 
       SET request_count = request_count + 1, 
           token_count = token_count + $1, 
           last_login_at = $2 
       WHERE id = $3`,
      [tokens, now, userId]
    );
  } else {
    const u = localStore.users.find((x) => x.id === userId);
    if (u) {
      u.request_count = (u.request_count || 0) + 1;
      u.token_count = (u.token_count || 0) + tokens;
      u.last_login_at = now;
      await saveLocalStore();
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Opérations Sessions (durée longue : 90 jours, glissantes)                  */
/* -------------------------------------------------------------------------- */

export async function createSession(userId, durationDays = SESSION_DAYS) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();
  const createdAt = new Date().toISOString();

  if (usePostgres) {
    await q(`INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES ($1, $2, $3, $4)`, [
      token,
      userId,
      expiresAt,
      createdAt,
    ]);
  } else {
    localStore.sessions.push({
      token,
      user_id: userId,
      expires_at: expiresAt,
      created_at: createdAt,
    });
    await saveLocalStore();
  }

  return { token, expiresAt };
}

export async function getSession(token) {
  if (!token) return null;

  if (usePostgres) {
    const res = await q(
      `SELECT s.*, u.pseudo, u.username, u.email, u.role, u.status, u.alert_message, 
              u.request_count, u.token_count, u.created_at as user_created_at
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = $1 AND s.expires_at > NOW()
       LIMIT 1`,
      [token]
    );
    return res.rows[0] || null;
  }

  const s = localStore.sessions.find((x) => x.token === token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    return null;
  }

  const u = localStore.users.find((x) => x.id === s.user_id);
  if (!u) return null;

  return {
    ...s,
    pseudo: u.pseudo,
    username: u.username,
    email: u.email,
    role: u.role,
    status: u.status,
    alert_message: u.alert_message,
    request_count: u.request_count || 0,
    token_count: u.token_count || 0,
    user_created_at: u.created_at,
  };
}

/**
 * Session glissante : prolonge la durée de vie d'une session encore valide.
 * Appelée automatiquement à chaque activité quand la session approche de son
 * échéance — l'utilisateur reste donc connecté tant qu'il revient au moins
 * une fois avant l'expiration, même après de longues périodes d'inactivité.
 * @returns {Promise<string>} la nouvelle date d'expiration (ISO)
 */
export async function refreshSession(token, durationDays = SESSION_DAYS) {
  const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();

  if (usePostgres) {
    await q(`UPDATE sessions SET expires_at = $1 WHERE token = $2`, [expiresAt, token]);
  } else {
    const s = localStore.sessions.find((x) => x.token === token);
    if (s) {
      s.expires_at = expiresAt;
      await saveLocalStore();
    }
  }

  return expiresAt;
}

export async function deleteSession(token) {
  if (!token) return;

  if (usePostgres) {
    await q(`DELETE FROM sessions WHERE token = $1`, [token]);
  } else {
    localStore.sessions = localStore.sessions.filter((s) => s.token !== token);
    await saveLocalStore();
  }
}

/* -------------------------------------------------------------------------- */
/* Enregistrement des Messages & Traffic                                      */
/* -------------------------------------------------------------------------- */

export async function saveMessage({
  userId,
  username,
  conversationId,
  role,
  content,
  model,
  template,
  tokensEstimate = 0,
  ip = "",
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  if (usePostgres) {
    await q(
      `INSERT INTO messages (id, user_id, username, conversation_id, role, content, model, template, tokens_estimate, ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        userId,
        username,
        conversationId || null,
        role,
        content,
        model || null,
        template || null,
        tokensEstimate,
        ip,
        createdAt,
      ]
    );
  } else {
    localStore.messages.push({
      id,
      user_id: userId,
      username,
      conversation_id: conversationId || null,
      role,
      content,
      model: model || null,
      template: template || null,
      tokens_estimate: tokensEstimate,
      ip,
      created_at: createdAt,
    });
    // Conserver max 5000 messages en local
    if (localStore.messages.length > 5000) {
      localStore.messages.splice(0, localStore.messages.length - 5000);
    }
    await saveLocalStore();
  }

  return { id, createdAt };
}

/* -------------------------------------------------------------------------- */
/* Dashboard Admin : Requêtes et Statistiques                                 */
/* -------------------------------------------------------------------------- */

export async function getAdminUsersList() {
  if (usePostgres) {
    const res = await q(`
      SELECT 
        u.id, u.pseudo, u.username, u.email, u.heard_from, u.role, u.status, 
        u.alert_message, u.request_count, u.token_count, u.created_at, u.last_login_at,
        u.register_ip, u.location, u.country_code,
        COUNT(m.id) as stored_messages_count
      FROM users u
      LEFT JOIN messages m ON u.id = m.user_id
      GROUP BY u.id
      ORDER BY u.created_at DESC
    `);
    return res.rows;
  }

  return localStore.users.map((u) => {
    const count = localStore.messages.filter((m) => m.user_id === u.id).length;
    return {
      ...u,
      stored_messages_count: count,
    };
  });
}

export async function getUserMessages(userId, limit = 100) {
  if (usePostgres) {
    const res = await q(
      `SELECT * FROM messages WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return res.rows;
  }

  return localStore.messages
    .filter((m) => m.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, limit);
}

export async function getAdminStats() {
  let totalUsers = 0;
  let activeUsers = 0;
  let suspendedUsers = 0;
  let bannedUsers = 0;
  let totalRequests = 0;
  let totalTokens = 0;
  let recentMessages = [];
  let modelStats = {};
  let templateStats = {};
  let timelineStats = {};
  let heardFromStats = {};

  if (usePostgres) {
    const usersRes = await q(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
        COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended,
        COUNT(CASE WHEN status = 'banned' THEN 1 END) as banned,
        COALESCE(SUM(request_count), 0) as total_requests,
        COALESCE(SUM(token_count), 0) as total_tokens
      FROM users
    `);
    const r = usersRes.rows[0];
    totalUsers = Number(r.total);
    activeUsers = Number(r.active);
    suspendedUsers = Number(r.suspended);
    bannedUsers = Number(r.banned);
    totalRequests = Number(r.total_requests);
    totalTokens = Number(r.total_tokens);

    const msgsRes = await q(`
      SELECT id, user_id, username, role, content, model, template, tokens_estimate, ip, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT 50
    `);
    recentMessages = msgsRes.rows;

    const modelsRes = await q(
      `SELECT model, COUNT(*) as count FROM messages WHERE model IS NOT NULL GROUP BY model`
    );
    modelsRes.rows.forEach((row) => (modelStats[row.model] = Number(row.count)));

    const templatesRes = await q(
      `SELECT template, COUNT(*) as count FROM messages WHERE template IS NOT NULL GROUP BY template`
    );
    templatesRes.rows.forEach((row) => (templateStats[row.template] = Number(row.count)));

    const heardRes = await q(
      `SELECT heard_from, COUNT(*) as count FROM users WHERE heard_from IS NOT NULL AND heard_from != '' GROUP BY heard_from`
    );
    heardRes.rows.forEach((row) => (heardFromStats[row.heard_from] = Number(row.count)));
  } else {
    totalUsers = localStore.users.length;
    activeUsers = localStore.users.filter((u) => u.status === "active").length;
    suspendedUsers = localStore.users.filter((u) => u.status === "suspended").length;
    bannedUsers = localStore.users.filter((u) => u.status === "banned").length;
    totalRequests = localStore.users.reduce((acc, u) => acc + (u.request_count || 0), 0);
    totalTokens = localStore.users.reduce((acc, u) => acc + (u.token_count || 0), 0);

    recentMessages = localStore.messages.slice(-50).reverse();

    localStore.messages.forEach((m) => {
      if (m.model) modelStats[m.model] = (modelStats[m.model] || 0) + 1;
      if (m.template) templateStats[m.template] = (templateStats[m.template] || 0) + 1;
    });

    localStore.users.forEach((u) => {
      if (u.heard_from) {
        heardFromStats[u.heard_from] = (heardFromStats[u.heard_from] || 0) + 1;
      }
    });
  }

  return {
    totalUsers,
    activeUsers,
    suspendedUsers,
    bannedUsers,
    totalRequests,
    totalTokens,
    recentMessages,
    modelStats,
    templateStats,
    heardFromStats,
    storageType: usePostgres ? "Neon PostgreSQL (persistant)" : degraded ? "Local dégradé (en attente de PostgreSQL)" : "Local (dev)",
  };
}
