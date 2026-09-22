// lib/auth.js — Système d'authentification et gestion des sessions utilisateur.
//
// Gère l'inscription avec les champs requis :
//   • Pseudo
//   • Où il a entendu parler de Venice pour la 1ère fois (heard_from)
//   • Mot de passe
//   • user_name sans espace
//   • Adresse e-mail
//
// Connexion :
//   • Soit par e-mail, soit par user_name
//   • Mot de passe
//   • Durée de session persistante (90 jours)

import bcrypt from "bcryptjs";
import {
  createUser,
  findUserByUsernameOrEmail,
  findUserById,
  createSession,
  getSession,
  refreshSession,
  deleteSession,
  getAdminCredentials,
  updateUserAlert,
  SESSION_DAYS,
} from "./db.js";

/**
 * Session glissante : si une session encore valide approche de son échéance
 * (moins de 60 jours restants sur une durée de 90 jours), elle est prolongée
 * automatiquement à chaque activité. Tant que l'utilisateur revient au moins
 * une fois tous les 60 jours — même après de longues inactivités — il reste
 * connecté pour toujours, sans jamais avoir à se reconnecter.
 */
const SESSION_SLIDE_THRESHOLD_MS = 60 * 86400000;

/** Extrait le token de session d'une requête HTTP (en-tête Authorization ou cookie) */
export function extractSessionToken(req) {
  // En-tête Authorization: Bearer <token>
  const authHeader = req.headers["authorization"] || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }

  // Cookie venice_session=<token>
  const cookieHeader = req.headers["cookie"] || "";
  const match = cookieHeader.match(/(?:^|;\s*)venice_session=([^;]+)/);
  if (match) {
    return decodeURIComponent(match[1]);
  }

  return null;
}

/** Valide et authentifie une requête (prolonge la session si nécessaire) */
export async function authenticateRequest(req) {
  const token = extractSessionToken(req);
  if (!token) return null;

  const session = await getSession(token);
  if (!session) return null;

  // Renouvellement glissant de la session en base de données.
  let sessionExpiresAt = session.expires_at;
  let sessionRefreshed = false;
  const remainingMs = new Date(session.expires_at).getTime() - Date.now();
  if (Number.isFinite(remainingMs) && remainingMs < SESSION_SLIDE_THRESHOLD_MS) {
    try {
      sessionExpiresAt = await refreshSession(token, SESSION_DAYS);
      sessionRefreshed = true;
    } catch (err) {
      // La DB est momentanément indisponible : la session reste valide,
      // le renouvellement sera retenté à la prochaine requête.
      console.warn("[auth] Renouvellement de session différé :", err.message);
    }
  }

  return {
    token,
    sessionExpiresAt,
    sessionRefreshed,
    user: {
      id: session.user_id,
      pseudo: session.pseudo,
      username: session.username,
      email: session.email,
      role: session.role,
      status: session.status,
      alertMessage: session.alert_message,
      requestCount: session.request_count,
      tokenCount: session.token_count,
      createdAt: session.user_created_at,
    },
  };
}

/** Traite l'inscription d'un nouvel utilisateur */
export async function registerUser({ pseudo, username, email, heard_from, password }) {
  if (!pseudo || typeof pseudo !== "string" || !pseudo.trim()) {
    throw new Error("Le pseudo est obligatoire.");
  }
  if (!username || typeof username !== "string" || !username.trim()) {
    throw new Error("Le nom d'utilisateur (user_name) est obligatoire.");
  }
  const cleanUsername = username.trim();
  // Vérification user_name sans espace
  if (/\s/.test(cleanUsername)) {
    throw new Error("Le user_name ne doit contenir aucun espace.");
  }
  if (!/^[a-zA-Z0-9_\-\.]{3,30}$/.test(cleanUsername)) {
    throw new Error(
      "Le user_name doit comporter entre 3 et 30 caractères (lettres, chiffres, tirets, underscores ou points)."
    );
  }

  if (!email || typeof email !== "string" || !email.trim()) {
    throw new Error("L'adresse e-mail est obligatoire.");
  }
  const cleanEmail = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    throw new Error("L'adresse e-mail n'est pas valide.");
  }

  if (!heard_from || typeof heard_from !== "string" || !heard_from.trim()) {
    throw new Error("Veuillez indiquer où vous avez entendu parler de Venice pour la première fois.");
  }

  if (!password || typeof password !== "string" || password.length < 6) {
    throw new Error("Le mot de passe doit comporter au moins 6 caractères.");
  }

  // Vérifier si un utilisateur existe déjà avec cet email ou username
  const existingUser = await findUserByUsernameOrEmail(cleanUsername);
  if (existingUser) {
    throw new Error("Ce nom d'utilisateur est déjà utilisé.");
  }

  const existingEmail = await findUserByUsernameOrEmail(cleanEmail);
  if (existingEmail) {
    throw new Error("Cette adresse e-mail est déjà associée à un compte.");
  }

  // Création du compte
  const user = await createUser({
    pseudo: pseudo.trim(),
    username: cleanUsername,
    email: cleanEmail,
    heard_from: heard_from.trim(),
    password,
  });

  // Création de session longue durée (90 jours)
  const session = await createSession(user.id, 90);

  return {
    user: {
      id: user.id,
      pseudo: user.pseudo,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      alertMessage: user.alert_message,
      requestCount: user.request_count,
      tokenCount: user.token_count,
      createdAt: user.created_at,
    },
    token: session.token,
    expiresAt: session.expiresAt,
  };
}

/** Traite la connexion d'un utilisateur */
export async function loginUser({ identifier, password }) {
  if (!identifier || typeof identifier !== "string" || !identifier.trim()) {
    throw new Error("Veuillez saisir votre user_name ou votre adresse e-mail.");
  }
  if (!password || typeof password !== "string") {
    throw new Error("Veuillez saisir votre mot de passe.");
  }

  const cleanIdentifier = identifier.trim();

  // Vérifier si c'est l'admin direct configuré
  const adminCreds = await getAdminCredentials();
  const isAdminLogin =
    (cleanIdentifier.toLowerCase() === adminCreds.username.toLowerCase() ||
      cleanIdentifier.toLowerCase() === adminCreds.email.toLowerCase()) &&
    password === adminCreds.password;

  let user = await findUserByUsernameOrEmail(cleanIdentifier);

  if (!user && !isAdminLogin) {
    throw new Error("Identifiants incorrects (aucun compte trouvé).");
  }

  if (user) {
    // Vérifier mot de passe hashé
    const isPasswordValid = await bcrypt.compare(password, user.password_hash);
    if (!isPasswordValid && !isAdminLogin) {
      throw new Error("Mot de passe incorrect.");
    }
  } else if (isAdminLogin) {
    // L'utilisateur admin n'était pas encore en DB (cas exceptionnel), re-vérification
    user = await findUserByUsernameOrEmail(adminCreds.username);
  }

  if (!user) {
    throw new Error("Erreur de connexion inattendue.");
  }

  // Vérifier statut
  if (user.status === "banned") {
    const err = new Error("Ce compte a été banni. L'accès aux services est révoqué.");
    err.status = 403;
    err.code = "ACCOUNT_BANNED";
    throw err;
  }

  if (user.status === "suspended") {
    const err = new Error("Ce compte est temporairement suspendu. Contactez le support.");
    err.status = 403;
    err.code = "ACCOUNT_SUSPENDED";
    throw err;
  }

  // Création de la session (90 jours)
  const session = await createSession(user.id, 90);

  return {
    user: {
      id: user.id,
      pseudo: user.pseudo,
      username: user.username,
      email: user.email,
      role: user.role,
      status: user.status,
      alertMessage: user.alert_message,
      requestCount: user.request_count || 0,
      tokenCount: user.token_count || 0,
      createdAt: user.created_at,
    },
    token: session.token,
    expiresAt: session.expiresAt,
    isAdmin: user.role === "admin",
  };
}

/** Déconnecte un utilisateur en révoquant son jeton */
export async function logoutUser(token) {
  if (token) {
    await deleteSession(token);
  }
}
