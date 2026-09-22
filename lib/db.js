// lib/db.js — Gestionnaire de base de données PostgreSQL Neon avec repli local persistant.
//
// Venice utilise Neon PostgreSQL (variable DATABASE_URL obligatoire sur Render).
// En cas d'inaccessibilité réseau (ex: sandbox de test ou coupure), le module
// bascule automatiquement et de façon transparente sur un stockage local JSON persistant
// pour garantir la haute disponibilité et la testabilité sans interruption de service.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import pg from "pg";
import bcrypt from "bcryptjs";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const LOCAL_DB_PATH = join(ROOT_DIR, "data", "venice_store.json");
const ADMIN_CREDS_PATH = join(ROOT_DIR, "admin-credentials.json");

let pool = null;
let usePostgres = false;
let isInitialized = false;

// Mémoire de secours si Postgres n'est pas joignable
let localStore = {
  users: [],
  sessions: [],
  messages: [],
  auditLogs: [],
};

/** Charge les identifiants admin depuis admin-credentials.json */
export async function getAdminCredentials() {
  try {
    if (existsSync(ADMIN_CREDS_PATH)) {
      const raw = await readFile(ADMIN_CREDS_PATH, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn("[db] Impossible de lire admin-credentials.json :", err.message);
  }
  return {
    username: "CrazyPrince",
    email: "francisvoufo@gmail.com",
    password: "CRAZY237",
  };
}

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
      localStore = JSON.parse(raw);
      if (!Array.isArray(localStore.users)) localStore.users = [];
      if (!Array.isArray(localStore.sessions)) localStore.sessions = [];
      if (!Array.isArray(localStore.messages)) localStore.messages = [];
      if (!Array.isArray(localStore.auditLogs)) localStore.auditLogs = [];
    }
  } catch (err) {
    console.warn("[db] Création d'un nouveau store local suite à :", err.message);
  }
}

/** Initialise la base de données (PostgreSQL Neon ou Local Store) */
export async function initDb(databaseUrl = process.env.DATABASE_URL) {
  if (isInitialized) return { usePostgres };

  await loadLocalStore();
  const adminCreds = await getAdminCredentials();

  if (databaseUrl) {
    try {
      // Configuration de la connexion Neon Postgres
      pool = new Pool({
        connectionString: databaseUrl,
        ssl: { rejectUnauthorized: false },
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 10000,
      });

      // Test de connexion rapide
      const client = await pool.connect();
      client.release();
      usePostgres = true;
      console.log("[db] Connecté avec succès à PostgreSQL Neon !");

      // Création des tables si elles n'existent pas
      await createPostgresTables();
    } catch (err) {
      console.warn(
        `[db] PostgreSQL Neon non joignable (${err.message}) -> Bascule sur le stockage persistant local.`
      );
      usePostgres = false;
      if (pool) {
        try {
          await pool.end();
        } catch {
          /* noop */
        }
        pool = null;
      }
    }
  } else {
    console.log("[db] Aucune DATABASE_URL fournie -> Utilisation du stockage persistant local.");
    usePostgres = false;
  }

  // Synchronisation du compte admin
  await ensureAdminUser(adminCreds);

  isInitialized = true;
  return { usePostgres };
}

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
  `;
  await pool.query(schema);
}

/** Assure que l'utilisateur Admin existe avec les bons identifiants */
async function ensureAdminUser(adminCreds) {
  const hash = await bcrypt.hash(adminCreds.password, 10);
  const now = new Date().toISOString();

  if (usePostgres) {
    const res = await pool.query(
      `SELECT * FROM users WHERE username = $1 OR email = $2 LIMIT 1`,
      [adminCreds.username, adminCreds.email]
    );

    if (res.rows.length === 0) {
      const id = "admin-" + randomUUID().slice(0, 8);
      await pool.query(
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
      await pool.query(
        `UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2`,
        [hash, existing.id]
      );
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
    const res = await pool.query(
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
    const res = await pool.query(`SELECT * FROM users WHERE id = $1 LIMIT 1`, [id]);
    return res.rows[0] || null;
  }

  return localStore.users.find((u) => u.id === id) || null;
}

export async function createUser({ pseudo, username, email, heard_from, password }) {
  const hash = await bcrypt.hash(password, 10);
  const id = randomUUID();
  const now = new Date().toISOString();

  if (usePostgres) {
    const res = await pool.query(
      `INSERT INTO users (id, pseudo, username, email, heard_from, password_hash, role, status, created_at, last_login_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'user', 'active', $7, $7)
       RETURNING *`,
      [id, pseudo, username, email, heard_from || "", hash, now]
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
    created_at: now,
    last_login_at: now,
  };
  localStore.users.push(user);
  await saveLocalStore();
  return user;
}

export async function updateUserStatus(userId, status) {
  if (usePostgres) {
    await pool.query(`UPDATE users SET status = $1 WHERE id = $2`, [status, userId]);
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
    await pool.query(`UPDATE users SET alert_message = $1 WHERE id = $2`, [alert, userId]);
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
    await pool.query(
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
/* Opérations Sessions (Durée longue : 90 jours)                              */
/* -------------------------------------------------------------------------- */

export async function createSession(userId, durationDays = 90) {
  const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
  const expiresAt = new Date(Date.now() + durationDays * 86400000).toISOString();
  const createdAt = new Date().toISOString();

  if (usePostgres) {
    await pool.query(
      `INSERT INTO sessions (token, user_id, expires_at, created_at)
       VALUES ($1, $2, $3, $4)`,
      [token, userId, expiresAt, createdAt]
    );
  } else {
    localStore.sessions.push({ token, user_id: userId, expires_at: expiresAt, created_at: createdAt });
    await saveLocalStore();
  }

  return { token, expiresAt };
}

export async function getSession(token) {
  if (!token) return null;

  if (usePostgres) {
    const res = await pool.query(
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

export async function deleteSession(token) {
  if (!token) return;

  if (usePostgres) {
    await pool.query(`DELETE FROM sessions WHERE token = $1`, [token]);
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
    await pool.query(
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
    const res = await pool.query(`
      SELECT 
        u.id, u.pseudo, u.username, u.email, u.heard_from, u.role, u.status, 
        u.alert_message, u.request_count, u.token_count, u.created_at, u.last_login_at,
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
    const res = await pool.query(
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
    const usersRes = await pool.query(`
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

    const msgsRes = await pool.query(`
      SELECT id, user_id, username, role, content, model, template, tokens_estimate, ip, created_at
      FROM messages
      ORDER BY created_at DESC
      LIMIT 50
    `);
    recentMessages = msgsRes.rows;

    const modelsRes = await pool.query(`
      SELECT model, COUNT(*) as count FROM messages WHERE model IS NOT NULL GROUP BY model
    `);
    modelsRes.rows.forEach((row) => (modelStats[row.model] = Number(row.count)));

    const templatesRes = await pool.query(`
      SELECT template, COUNT(*) as count FROM messages WHERE template IS NOT NULL GROUP BY template
    `);
    templatesRes.rows.forEach((row) => (templateStats[row.template] = Number(row.count)));

    const heardRes = await pool.query(`
      SELECT heard_from, COUNT(*) as count FROM users WHERE heard_from IS NOT NULL AND heard_from != '' GROUP BY heard_from
    `);
    heardRes.rows.forEach((row) => (heardFromStats[row.heard_from] = Number(row.count)));
  } else {
    totalUsers = localStore.users.length;
    activeUsers = localStore.users.filter((u) => u.status === "active").length;
    suspendedUsers = localStore.users.filter((u) => u.status === "suspended").length;
    bannedUsers = localStore.users.filter((u) => u.status === "banned").length;
    totalRequests = localStore.users.reduce((acc, u) => acc + (u.request_count || 0), 0);
    totalTokens = localStore.users.reduce((acc, u) => acc + (u.token_count || 0), 0);

    recentMessages = localStore.messages
      .slice(-50)
      .reverse();

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
    storageType: usePostgres ? "Neon PostgreSQL" : "Local Store Persistant",
  };
}
