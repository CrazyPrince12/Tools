// demo.js — mode DÉMO : réponses simulées, zéro réseau.
//
// Activé par DEMO_MODE=1. Il permet de faire tourner l'interface (design,
// historique, animations, streaming) en local, en preview ou dans un
// environnement sans accès sortant vers chat.dphn.ai. Le badge du header
// affiche alors « mode démo » : jamais d'ambiguïté.

const CANNED = [
  {
    match: /qui (es|est)-tu|ton nom|qui t'a|présente/i,
    reply: `Je suis **Venice**, créée par Crazy Prince.

Je tourne sur les modèles **Dolphin** du chat officiel, relayés par une passerelle : côté navigateur, rien d'autre à configurer.

- **Modèles** : 24B, X1 Nano, Alpha-200, Alpha-225
- **Rôles** : logique, créatif, synthèse, code débutant, code avancé
- **Historique** : sauvegardé localement, dans *ton* navigateur`,
  },
  {
    match: /cloudflare|scrap|passerelle|comment ça marche|architecture/i,
    reply: `## Comment Venice parle à Dolphin

Venice n'appelle pas une API maison : elle rejoue le trafic du site officiel \`chat.dphn.ai\`.

1. **Chromium headless** (Playwright) ouvre le site et résout le challenge Cloudflare.
2. Les cookies \`cf_clearance\` + \`__cf_ob\` sont récupérés et mis en cache côté serveur.
3. Un **fetch Node natif** rejoue ces cookies sur \`/api/models\`, \`/api/templates\` et \`/api/chat\`.
4. Le flux **SSE** de Dolphin est re-streamé vers ton navigateur, token par token.
5. Si Cloudflare invalide la session (\`403 cf-mitigated: challenge\`), le cookie est rafraîchi et la requête rejouée automatiquement.`,
  },
  {
    match: /code|javascript|fonction|script/i,
    reply: `Voici un exemple minimal côté Node :

\`\`\`js
const res = await fetch("https://chat.dphn.ai/api/chat", {
  method: "POST",
  headers: {
    "user-agent": USER_AGENT,
    cookie: \`cf_clearance=\${cookie}\`,
    "content-type": "application/json",
    accept: "text/event-stream, */*",
  },
  body: JSON.stringify({
    messages: [{ role: "user", content: "Salut" }],
    model: "dolphinserver:24B",
    template: "logical",
  }),
});
\`\`\`

Le corps de la réponse arrive en **SSE** : une trame par token, terminée par \`data: [DONE]\`.`,
  },
];

const FALLBACK = `**Mode démo actif.**

La passerelle tourne, l'interface est complète, mais les réponses sont simulées : cet environnement n'a pas d'accès sortant vers \`chat.dphn.ai\`.

Ce que tu peux tester ici :

- le **rendu formaté** des réponses (titres, listes, code, tableaux, liens)
- le **streaming** token par token
- le menu **Historique** en haut à gauche (conversations enregistrées dans le navigateur)
- le changement de **modèle** et de **rôle**
- les thèmes **abysses** / **lagon** et l'animation GSAP

Déploie sur Render avec \`DEMO_MODE=0\` pour interroger le vrai Dolphin.`;

/** Réponse simulée correspondant (approximativement) à la question. */
export function demoTextFrom(question = "") {
  const found = CANNED.find((entry) => entry.match.test(question));
  return found ? found.reply : FALLBACK;
}

/** Même contenu, découpé en petits morceaux pour simuler le streaming SSE. */
export async function* demoStream(question = "", { chunkSize = 12, delayMs = 12 } = {}) {
  const text = demoTextFrom(question);
  for (let i = 0; i < text.length; i += chunkSize) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    yield text.slice(i, i + chunkSize);
  }
}
