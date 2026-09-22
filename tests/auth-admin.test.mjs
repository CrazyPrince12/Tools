// tests/auth-admin.test.mjs — Tests du système d'authentification et de la surveillance admin.

import test from "node:test";
import assert from "node:assert/strict";

import { createApp } from "../server.js";
import { createRuntime } from "../lib/runtime.js";
import { initDb } from "../lib/db.js";

const silentLog = { log() {}, warn() {}, error() {} };

async function startTestServer() {
  await initDb();
  const runtime = createRuntime({ DEMO_MODE: "1" }, { log: silentLog });
  const server = createApp({ DEMO_MODE: "1" }, runtime);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("Inscription : refuse les user_name contenant des espaces", async () => {
  const ctx = await startTestServer();
  try {
    const res = await fetch(`${ctx.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pseudo: "Test User",
        username: "user with spaces",
        email: "test_spaces@example.com",
        heard_from: "Google",
        password: "password123",
      }),
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error.message, /espace/i);
  } finally {
    await ctx.close();
  }
});

test("Inscription & Connexion standard par email et username", async () => {
  const ctx = await startTestServer();
  const testId = Date.now();
  const username = `alice_${testId}`;
  const email = `alice_${testId}@example.com`;

  try {
    // Inscription
    const regRes = await fetch(`${ctx.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pseudo: "Alice Test",
        username,
        email,
        heard_from: "WhatsApp",
        password: "secretpassword",
      }),
    });
    assert.equal(regRes.status, 201);
    const regData = await regRes.json();
    assert.equal(regData.user.username, username);
    assert.ok(regData.token);

    // Connexion via username
    const loginUserRes = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: username,
        password: "secretpassword",
      }),
    });
    assert.equal(loginUserRes.status, 200);
    const loginUserData = await loginUserRes.json();
    assert.equal(loginUserData.user.email, email);

    // Connexion via email
    const loginEmailRes = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: email,
        password: "secretpassword",
      }),
    });
    assert.equal(loginEmailRes.status, 200);
  } finally {
    await ctx.close();
  }
});

test("Connexion Admin avec identifiants CrazyPrince et redirection sécurisée", async () => {
  const ctx = await startTestServer();
  try {
    // Connexion avec username admin
    const res = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "CrazyPrince",
        password: "CRAZY237",
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.user.role, "admin");
    assert.equal(data.isAdmin, true);

    const adminToken = data.token;

    // Accès aux stats admin avec le jeton
    const statsRes = await fetch(`${ctx.base}/api/admin/stats`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(statsRes.status, 200);
    const stats = await statsRes.json();
    assert.ok(typeof stats.totalUsers === "number");

    // Accès refusé à l'admin sans token
    const statsAnonRes = await fetch(`${ctx.base}/api/admin/stats`);
    assert.equal(statsAnonRes.status, 403);

    // Route /admin redirige si non connecté
    const pageRes = await fetch(`${ctx.base}/admin`, { redirect: "manual" });
    assert.equal(pageRes.status, 302);
  } finally {
    await ctx.close();
  }
});

test("Modération Admin : Bannir un utilisateur et message d'alerte", async () => {
  const ctx = await startTestServer();
  const testId = Date.now();
  const username = `baduser_${testId}`;
  const email = `bad_${testId}@example.com`;

  try {
    // Inscription user
    const regRes = await fetch(`${ctx.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pseudo: "Bad User",
        username,
        email,
        heard_from: "TikTok",
        password: "password123",
      }),
    });
    const regData = await regRes.json();
    const userId = regData.user.id;
    const userToken = regData.token;

    // Login Admin
    const adminRes = await fetch(`${ctx.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        identifier: "francisvoufo@gmail.com",
        password: "CRAZY237",
      }),
    });
    const adminData = await adminRes.json();
    const adminToken = adminData.token;

    // Envoi d'une alerte personnalisée
    const alertRes = await fetch(`${ctx.base}/api/admin/users/${userId}/alert`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ alertMessage: "Avertissement pour prompt non conforme." }),
    });
    assert.equal(alertRes.status, 200);

    // Vérification que l'utilisateur reçoit l'alerte sur /api/auth/me
    const meRes = await fetch(`${ctx.base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const meData = await meRes.json();
    assert.equal(meData.user.alertMessage, "Avertissement pour prompt non conforme.");

    // Bannissement de l'utilisateur
    const banRes = await fetch(`${ctx.base}/api/admin/users/${userId}/status`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ status: "banned" }),
    });
    assert.equal(banRes.status, 200);

    // Tentative de chat par l'utilisateur banni -> bloqué 403
    const chatRes = await fetch(`${ctx.base}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userToken}`,
      },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Test prompt banni" }],
        model: "dolphinserver:24B",
        template: "logical",
      }),
    });
    assert.equal(chatRes.status, 403);
    const chatErr = await chatRes.json();
    assert.equal(chatErr.error.code, "ACCOUNT_BANNED");
  } finally {
    await ctx.close();
  }
});

test("Persistance : cookie 90 jours + session glissante", async () => {
  const ctx = await startTestServer();
  const testId = Date.now();

  try {
    // 1. Inscription -> cookie PERSISTANT (Max-Age = 90 jours), pas un cookie
    //    de session qui meurt a la fermeture du navigateur.
    const regRes = await fetch(`${ctx.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pseudo: "Persist Test",
        username: `persist_${testId}`,
        email: `persist_${testId}@example.com`,
        heard_from: "Google",
        password: "password123",
      }),
    });
    assert.equal(regRes.status, 201);
    const regCookie = regRes.headers.get("set-cookie") || "";
    assert.match(regCookie, /venice_session=/);
    assert.match(regCookie, /Max-Age=7776000/); // 90 jours
    assert.match(regCookie, /HttpOnly/);
    assert.match(regCookie, /SameSite=Lax/);

    // 2. /api/auth/me renvoie authenticated + la date d'expiration de session.
    const { token } = await regRes.json();
    const meRes = await fetch(`${ctx.base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.authenticated, true);
    assert.ok(new Date(meData.sessionExpiresAt).getTime() > Date.now());

    // 3. Session glissante : une session bientot expiree (J+10) est prolongee
    //    automatiquement a 90 jours au premier passage, cookie renouvele.
    const { createUser, createSession } = await import("../lib/db.js");
    const tmpUser = await createUser({
      pseudo: "Slide",
      username: `slide_${testId}`,
      email: `slide_${testId}@example.com`,
      heard_from: "tests",
      password: "password123",
    });
    const shortSession = await createSession(tmpUser.id, 10); // 10 jours restants
    const meRes2 = await fetch(`${ctx.base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${shortSession.token}` },
    });
    assert.equal(meRes2.status, 200);
    const meData2 = await meRes2.json();
    assert.equal(meData2.authenticated, true);
    const extendedDays = (new Date(meData2.sessionExpiresAt) - Date.now()) / 86400000;
    assert.ok(
      extendedDays > 80,
      `session prolongee a ~90 jours (obtenu : ${extendedDays.toFixed(1)} j)`
    );
    const cookie2 = meRes2.headers.get("set-cookie") || "";
    assert.match(cookie2, /Max-Age=7776000/, "le cookie doit etre renouvele");
  } finally {
    await ctx.close();
  }
});
