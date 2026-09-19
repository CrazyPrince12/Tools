// mock-dolphin.mjs — faux chat.dphn.ai pour les tests et le développement.
//
// Reproduit fidèlement ce qui a été observé sur le vrai service :
//   • toutes les routes sont derrière un « challenge Cloudflare » :
//     sans cookie valide → 403 + `cf-mitigated: challenge` + page HTML ;
//   • GET /api/models   → {"data":[{id,label,vision}, …]}
//   • GET /api/templates→ {"data":[{name}, …]}
//   • POST /api/chat    → flux SSE de chunks `chat.completion.chunk`
//   • payload sans model/template → 400 {"error":"E4"}
//
// Utilisation :
//   node tests/mock-dolphin.mjs                    (port 8787)
//   PORT=9000 MOCK_STRICT_SYSTEM=1 node tests/mock-dolphin.mjs

import { createServer } from "node:http";

const MODELS = [
  { id: "dolphinserver:24B", label: "Dolphin 24B", vision: false },
  { id: "dolphinserver2:6b", label: "Dolphin X1 Nano", vision: false },
  { id: "dolphinserver3:trinity-mini-step200", label: "Alpha-200", vision: false },
  { id: "dolphinserver3:trinity-mini-step225", label: "Alpha-225", vision: false },
];

const TEMPLATES = ["logical", "creative", "summary", "code-beginner", "code-advanced"].map((name) => ({
  name,
}));

const GOOD_COOKIE = "cf_clearance=good";
const CHALLENGE_PAGE = `<!doctype html><html><head><title>Just a moment...</title></head>
<body><div id="cf-chl-widget">Enable JavaScript and cookies to continue</div></body></html>`;

function challenge(res) {
  res.writeHead(403, {
    "Content-Type": "text/html; charset=utf-8",
    "cf-mitigated": "challenge",
    server: "cloudflare",
  });
  res.end(CHALLENGE_PAGE);
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** Réponse simulée : écho structuré, suffisant pour vérifier le streaming. */
function fakeAnswer(body) {
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const hasSystem =
    body.messages?.[0]?.role === "system" ||
    (body.messages ?? []).some((m) => String(m.content || "").includes("[CONSIGNES SYSTÈME"));
  const system = hasSystem ? "avec consigne système. " : "";
  return [
    `## Réponse simulée\n\n${system}Modèle \`${body.model}\` · rôle **${body.template}**.\n\n`,
    `Tu as écrit : « ${String(lastUser?.content ?? "").slice(0, 120)} »\n\n`,
    "- le flux SSE arrive token par token\n- le rendu Markdown est appliqué côté navigateur\n\n",
    "```js\nconst modele = \"dolphinserver:24B\";\n```\n\nVoilà.",
  ];
}

export function createMockDolphin({ strictSystem = false, chunkDelayMs = 4 } = {}) {
  const state = { requests: [], bodies: [], strictSystem, accepted: 0, challenged: 0 };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.requests.push({ method: req.method, path: url.pathname, cookie: req.headers.cookie ?? "" });

    const cookie = req.headers.cookie ?? "";
    if (!cookie.includes(GOOD_COOKIE)) {
      state.challenged += 1;
      challenge(res);
      return;
    }
    state.accepted += 1;

    if (url.pathname === "/api/models" && req.method === "GET") return json(res, 200, { data: MODELS });
    if (url.pathname === "/api/templates" && req.method === "GET")
      return json(res, 200, { data: TEMPLATES });

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const body = await readBody(req);
      state.bodies.push(body);
      if (!body?.model || !body?.template || !Array.isArray(body?.messages)) {
        return json(res, 400, { error: "E4" });
      }
      if (strictSystem && body.messages[0]?.role === "system") {
        return json(res, 400, { error: "E4" });
      }

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant" }, index: 0 }] })}\n\n`
      );
      for (const chunk of fakeAnswer(body)) {
        await new Promise((resolve) => setTimeout(resolve, chunkDelayMs));
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><title>Dolphin Chat</title><body>ok</body></html>");
      return;
    }

    json(res, 404, { error: "not found" });
  });

  return {
    state,

    /** Démarre le mock et renvoie son URL de base. */
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      const { port: actual } = server.address();
      return `http://127.0.0.1:${actual}`;
    },

    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Exécution directe : serveur de développement.
if (process.argv[1]?.endsWith("mock-dolphin.mjs")) {
  const port = Number(process.env.PORT) || 8787;
  const mock = createMockDolphin({ strictSystem: /^(1|true)$/i.test(process.env.MOCK_STRICT_SYSTEM || "") });
  const base = await mock.listen(port);
  console.log(`[mock] chat.dphn.ai simulé sur ${base} (cookie attendu : ${GOOD_COOKIE})`);
  console.log(`[mock] mode strictSystem=${mock.state.strictSystem}`);
}
