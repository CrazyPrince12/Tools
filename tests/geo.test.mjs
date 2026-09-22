// tests/geo.test.mjs — Tests de la géolocalisation IP (100 % offline).
//
// Aucune requête réseau : on couvre les IP privées (jamais envoyées aux API),
// le switch VENICE_IP_GEO et la dégradation gracieuse.

import test from "node:test";
import assert from "node:assert/strict";

import { isPrivateIp, isGeoEnabled, locateIp } from "../lib/geo.js";

const silentLog = { log() {}, warn() {}, error() {} };

test("isPrivateIp : détecte les plages privées et locales", () => {
  assert.equal(isPrivateIp("127.0.0.1"), true);
  assert.equal(isPrivateIp("127.8.9.10"), true);
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("192.168.0.1"), true);
  assert.equal(isPrivateIp("172.16.0.1"), true);
  assert.equal(isPrivateIp("172.31.255.255"), true);
  assert.equal(isPrivateIp("169.254.1.1"), true);
  assert.equal(isPrivateIp("100.64.0.1"), true);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fc00::abcd"), true);
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateIp(""), true);
  assert.equal(isPrivateIp(null), true);
});

test("isPrivateIp : laisse passer les IP publiques", () => {
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("1.1.1.1"), false);
  assert.equal(isPrivateIp("92.98.154.10"), false);
  assert.equal(isPrivateIp("172.32.0.1"), false); // juste hors de 172.16/12
  assert.equal(isPrivateIp("100.128.0.1"), false); // juste hors de 100.64/10
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
});

test("isGeoEnabled : activée par défaut, désactivable", () => {
  assert.equal(isGeoEnabled({}), true);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "" }), true);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "1" }), true);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "true" }), true);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "0" }), false);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "off" }), false);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "false" }), false);
  assert.equal(isGeoEnabled({ VENICE_IP_GEO: "disabled" }), false);
});

test("locateIp : IP privée → « Local », aucun appel externe", async () => {
  const r = await locateIp("127.0.0.1", { enabled: true, log: silentLog });
  assert.equal(r.ip, "127.0.0.1");
  assert.equal(r.location, "Local");
  assert.equal(r.countryCode, null);
});

test("locateIp : désactivée → localisation null (l'IP est conservée)", async () => {
  const r = await locateIp("8.8.8.8", { enabled: false, log: silentLog });
  assert.equal(r.ip, "8.8.8.8");
  assert.equal(r.location, null);
  assert.equal(r.countryCode, null);
});

test("locateIp : IP vide / inconnue → null, sans lever", async () => {
  const r1 = await locateIp("", { log: silentLog });
  assert.equal(r1.ip, null);
  assert.equal(r1.location, null);
  const r2 = await locateIp("unknown", { log: silentLog });
  assert.equal(r2.ip, "unknown");
  assert.equal(r2.location, null);
});
