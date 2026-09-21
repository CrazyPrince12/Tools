<div align="center">

<img src="public/assets/venice.svg" width="132" alt="Venice" />

# VENICE

**Les modèles et les rôles du chat Dolphin, dans une interface fluide.**
Passerelle Node.js auto-hébergée qui résout le challenge Cloudflare de [`chat.dphn.ai`](https://chat.dphn.ai/), rejoue la session comme un vrai navigateur et vous restitue le streaming token par token.

<p>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-35e0d4?style=for-the-badge&logo=node.js&logoColor=04121f&labelColor=04121f" alt="Node 20+"></a>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Playwright-Chromium-2a8fe0?style=for-the-badge&logo=playwright&logoColor=04121f&labelColor=04121f" alt="Playwright"></a>
  <a href="https://render.com"><img src="https://img.shields.io/badge/Deploy-Render-46E3B7?style=for-the-badge&logo=render&logoColor=04121f&labelColor=04121f" alt="Render"></a>
  <a href="https://developer.mozilla.org/docs/Web/API/Server-sent_events"><img src="https://img.shields.io/badge/Stream-SSE-8ff7ea?style=for-the-badge&logo=serverless&logoColor=04121f&labelColor=04121f" alt="SSE"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licence-MIT-ff8a6b?style=for-the-badge&logo=opensourceinitiative&logoColor=04121f&labelColor=04121f" alt="MIT"></a>
  <a href="tests/venice.test.mjs"><img src="https://img.shields.io/badge/tests-32%20%2F%2032-38e0a5?style=for-the-badge&logo=nodedotjs&logoColor=04121f&labelColor=04121f" alt="Tests"></a>
</p>

Créé par **Crazy Prince** · Douala, Cameroun 🇨🇲

</div>

---

> **v2 — édition « passerelle ».** La v1 de Venice tapait directement l'API Hugging Face
> (`Dolphin-Mistral-24B-Venice-Edition` via Featherless) et s'arrêtait aux quotas de tokens.
> La v2 supprime la clé d'API : elle **scrape le chat officiel Dolphin** en pilotant un
> Chromium headless pour franchir Cloudflare, puis relaie le flux SSE. Même interface,
> même empreinte visuelle, zéro token à payer.

## Sommaire

| | |
|---|---|
| [Démo & principes](#-démo--principes) | [Architecture](#-architecture) |
| [Fonctionnalités](#-fonctionnalités) | [Structure](#-structure-du-projet) |
| [Démarrage rapide](#-démarrage-rapide) | [Configuration](#-configuration) |
| [API](#-api) | [Déploiement Render](#-déploiement-render) |
| [Déploiement Vercel](#-déploiement-vercel) | [Tests](#-tests) |
| [Sécurité & éthique](#-sécurité--éthique) | [Dépannage](#-dépannage) |
| [Feuille de route](#-feuille-de-route) | |

## ✨ Démo & principes

| Principe | Traduction dans le code |
|---|---|
| **Aucune clé, aucun quota** | L'accès repose sur une session Cloudflare obtenue en pilotant un navigateur — pas sur un compte payant. |
| **Le navigateur ne connaît aucun secret** | Le front n'appelle que `/api/*` ; la session `cf_clearance` reste côté serveur. |
| **Dégradation élégante** | Le catalogue embarqué prend le relais si l'amont tombe, et l'interface reste complète en mode démo. |
| **Client raisonnable** | Rate limit par IP, cache du catalogue, rafraîchissements préventifs — on ne matraque pas l'amont. |
| **Historique privé** | Les conversations vivent dans `localStorage`. Rien n'est stocké côté serveur. |

## 🔧 Fonctionnalités

- **Chat streaming** — tokens relayés au fil de l'eau (`text/event-stream`), avec curseur de frappe et repli JSON.
- **Tous les modèles Dolphin** — `Dolphin 24B`, `Dolphin X1 Nano`, `Alpha-200`, `Alpha-225` (lus en direct sur `/api/models`).
- **Tous les rôles Dolphin** — `Logique`, `Créatif`, `Synthèse`, `Code débutant`, `Code avancé` (lus sur `/api/templates`).
- **Instructions personnalisées** — un prompt additionnel par conversation, injecté côté serveur.
- **Menu Historique** (extrême gauche du header) — conversations multiples, recherche plein texte, renommage, suppression, « tout effacer », tout en `localStorage`.
- **Rendu formaté** — titres, listes, tableaux, citations, blocs de code avec bouton *Copier*, liens sécurisés. Construit en DOM pur, jamais `innerHTML`.
- **Empreinte visuelle Venice** — océan animé (GSAP), thèmes *abysses* / *lagon*, badge de session, accueil selon l'heure, footer Cameroun.
- **Résilience Cloudflare** — rafraîchissement préventif toutes les 12 min, à la demande, et rejeu automatique au premier `403 cf-mitigated: challenge`.
- **Mode démo** — `DEMO_MODE=1` : réponses simulées, interface et historique entièrement fonctionnels hors ligne.

## 🧠 Architecture

```
                 ┌──────────────────────────────────────────────────────────┐
   Navigateur    │  Venice — frontend statique (public/)                    │
   (vous)        │  HTML · CSS · JS vanille · GSAP · localStorage           │
                 └───────────────┬──────────────────────────────────────────┘
                                 │  fetch /api/chat (SSE montant/descendant)
                 ┌───────────────▼──────────────────────────────────────────┐
   Passerelle    │  Node natif (server.js + lib/httpApi.js)                 │
   (conteneur)   │  validation · rate limit · cache catalogue · SSE         │
                 └───────┬───────────────────────────────┬──────────────────┘
                         │                               │
        cookie frais ────┘                fetch natif (undici) avec cookie
                         │                               │
        ┌────────────────▼──────────────┐   ┌────────────▼──────────────────┐
        │ lib/cloudflare.js             │   │ lib/dolphin.js                │
        │ Chromium headless (Playwright)│   │ GET  /api/models              │
        │ → résout le challenge         │   │ GET  /api/templates           │
        │ → cf_clearance + __cf_ob      │   │ POST /api/chat  → SSE         │
        └───────────────────────────────┘   └────────────┬──────────────────┘
                                                         │
                                            https://chat.dphn.ai  (Cloudflare)
```

**Le cycle, en clair :**

1. Un Chromium headless ouvre `https://chat.dphn.ai/` et laisse Cloudflare exécuter son challenge.
2. Les cookies (`cf_clearance`, `__cf_ob`, `__cf_bm`) sont extraits et **vérifiés** par un appel réel à `/api/models` depuis la page.
3. Un `fetch` Node natif rejoue ces cookies avec le **même User-Agent** (Cloudflare lie le cookie à l'empreinte IP + UA).
4. La réponse SSE de `/api/chat` est parsée, normalisée (`choices[].delta.content` → `{delta}`) et re-streamée au navigateur.
5. Cookie expiré ou `403 cf-mitigated: challenge` → nouveau passage par le point 1, puis rejeu automatique (une seule fois).

> **Où héberger quoi ?** L'interface (`public/`) est purement statique : elle peut vivre sur Vercel.
> La passerelle, elle, a besoin d'un **Chromium persistant et d'une IP stable** — donc d'un conteneur
> (Render, Docker, Fly.io, VPS). Vercel ne peut pas tenir la session Cloudflare : voir
> [Déploiement Vercel](#-déploiement-vercel).

## 🧰 Stack technique

| Couche | Technologies |
|---|---|
| **Runtime** | Node.js 20+ (ESM, zéro framework HTTP), `node:test` |
| **Contournement Cloudflare** | Playwright · Chromium headless · contexte navigateur réaliste |
| **Transport** | `fetch` natif (undici), Server-Sent Events, parsing incrémental UTF-8 |
| **Frontend** | HTML5 sémantique · CSS3 (Grid, Flexbox, `color-mix`, thèmes) · JavaScript vanille · GSAP 3 · SVG sprite (aucun emoji) |
| **Persistance** | `localStorage` (conversations, thème) — côté navigateur uniquement |
| **Config** | Variables d'environnement (Render, Vercel, Docker) · `.env` maison zéro dépendance · pousseur `npm run vercel:env` |
| **Déploiement** | Docker (`node:22-bookworm-slim`) · Render Blueprint (`render.yaml`) · interface statique Vercel (`vercel.json`) |
| **Qualité** | 32 tests `node:test` (unitaires + intégration HTTP + plateformes serverless) · faux `chat.dphn.ai` intégré |

## 📁 Structure du projet

```
.
├── server.js              Serveur HTTP : statique + routes /api + boucle de session
├── index.js               Entrée générique (Render exécute « node index.js »)
├── config.js              Configuration centralisée (lue depuis l'environnement)
├── Dockerfile             Image de production (Chromium + dépendances système)
├── render.yaml            Blueprint Render (runtime Docker)
├── vercel.json            Interface statique sur Vercel (+ réécriture /api/* optionnelle)
├── .env.vercel.example    Modèle de variables pour Vercel (copier en .env.vercel)
├── scripts/
│   └── vercel-env.mjs     Pousse .env.vercel vers Vercel (npm run vercel:env)
├── src/
│   ├── prompt.js          Identité et règles de Venice (prompt système)
│   ├── skills.js          Compétences injectées dans le prompt système
│   └── catalog.js         Catalogue de secours + libellés FR + icônes des rôles
├── lib/
│   ├── cloudflare.js      Solveur Playwright du challenge Cloudflare
│   ├── session.js         Cycle de vie du cookie (TTL, mutex, reprise)
│   ├── dolphin.js         Client amont : en-têtes, retries, SSE, catalogue
│   ├── sse.js             Parseur/sérialiseur Server-Sent Events
│   ├── catalog.js         Cache du catalogue (live → dernier connu → secours)
│   ├── messages.js        Validation des payloads + stratégies de system prompt
│   ├── ratelimit.js       Fenêtre glissante par IP
│   ├── httpApi.js         Routes /api/chat · /api/catalog · /api/health · /api/session/refresh
│   ├── runtime.js         Assemblage (config + session + cache + rate limit)
│   ├── demo.js            Réponses simulées (DEMO_MODE)
│   └── env.js             Lecteur .env zéro dépendance
├── public/                Frontend Venice (aucun build)
│   ├── index.html         Interface + sprite SVG + menu Historique
│   ├── style.css          Thèmes abysses/lagon, océan, drawer, responsive
│   ├── script.js          Conversations locales, streaming, rendu formaté, GSAP
│   └── assets/            venice.svg · cameroun.svg
└── tests/
    ├── mock-dolphin.mjs   Faux chat.dphn.ai (challenge CF + SSE)
    ├── venice.test.mjs    Suite node:test (32 tests)
    └── real-check.mjs     Vérification réelle contre chat.dphn.ai
```

## 🚀 Démarrage rapide

### Local

```bash
npm install
npx playwright install --with-deps chromium   # une seule fois (télécharge Chromium)
npm start                                     # → http://localhost:3000
```

**Sans navigateur ni réseau** (interface complète, réponses simulées) :

```bash
npm run demo        # DEMO_MODE=1
npm run mock        # à part : faux chat.dphn.ai sur http://127.0.0.1:8787
DOLPHIN_BASE_URL=http://127.0.0.1:8787 DOLPHIN_COOKIE="cf_clearance=good" npm start
```

### Docker

```bash
docker build -t venice .
docker run --rm -p 10000:10000 venice          # → http://localhost:10000
```

## ⚙️ Configuration

Toutes les variables sont optionnelles : Venice fonctionne avec ses défauts.
Le fichier [`.env.example`](.env.example) les documente en détail.

| Variable | Défaut | Rôle |
|---|---|---|
| `DOLPHIN_BASE_URL` | `https://chat.dphn.ai` | Cible scrapée |
| `DOLPHIN_USER_AGENT` | Chrome 126 (Windows) | UA partagé navigateur ↔ fetch (Cloudflare lie l'empreinte) |
| `DOLPHIN_COOKIE` | — | Cookie injecté à la main (`cf_clearance=…; __cf_ob=…`) — dépannage, tests, dev |
| `DOLPHIN_SOLVER` | `playwright` | `playwright` ou `none` (cookie manuel uniquement) |
| `PLAYWRIGHT_MODULE` | `playwright` | Module à charger (`patchright` si Cloudflare durcit) |
| `DOLPHIN_SOLVER_TIMEOUT_MS` | `90000` | Temps laissé au challenge |
| `DOLPHIN_COOKIE_TTL_MS` | `1200000` | Durée de validité estimée du cookie (20 min) |
| `DOLPHIN_REFRESH_INTERVAL_MS` | `720000` | Cadence de la boucle de rafraîchissement |
| `DOLPHIN_SYSTEM_MODE` | `auto` | `auto` · `system` · `message` · `none` (injection du prompt système) |
| `DOLPHIN_EXTRA_BODY` | — | JSON ajouté au corps de `/api/chat` (ex. `{"temperature":0.7}`) |
| `DOLPHIN_STREAM_IDLE_MS` | `60000` | Coupure si le flux amont se tait |
| `DOLPHIN_CATALOG_TTL_MS` | `600000` | Cache du catalogue modèles/rôles |
| `VENICE_RATE_LIMIT` | `30` | Requêtes `/api/chat` par minute et par IP (`0` = illimité) |
| `VENICE_CONTEXT_WINDOW` | `20` | Messages envoyés au modèle |
| `VENICE_STORED_MESSAGES` | `80` | Messages conservés par conversation (navigateur) |
| `VENICE_MAX_CONVERSATIONS` | `60` | Conversations conservées (navigateur) |
| `VENICE_SYSTEM_PROMPT` | `src/prompt.js` | Remplace le prompt système |
| `DEMO_MODE` | `0` | `1` = réponses simulées, aucun appel sortant |
| `VENICE_ALLOWED_ORIGINS` | — | Origines autorisées en CORS (interface servie par un autre domaine). Vide = aucun en-tête CORS |
| `ADMIN_TOKEN` | — | Active `POST /api/session/refresh` (en-tête `x-admin-token`) |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Écoute HTTP |

## 🔌 API

### `POST /api/chat`

```bash
curl -N http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{
    "messages": [{ "role": "user", "content": "Explique les closures en JS" }],
    "model": "dolphinserver:24B",
    "template": "code-advanced",
    "instructions": "réponds en anglais"
  }'
```

Réponse `text/event-stream` :

```text
data: {"status":"started","model":"dolphinserver:24B","template":"code-advanced","author":"Crazy Prince"}

data: {"delta":"Une closure, "}

data: {"delta":"c'est une fonction…"}

data: [DONE]
```

En cas d'échec, une trame d'erreur précède la fin du flux :

```text
data: {"error":{"status":503,"message":"Cloudflare exige un défi interactif…","code":"SOLVER_FAILED"}}
```

`"stream": false` (ou `?stream=0`) renvoie `{"reply": "…", "model": "…", "template": "…"}`.

### Autres routes

| Route | Réponse |
|---|---|
| `GET /api/models` | `{"data":[{"id","label","vision","blurb","tone"}],"source","fetchedAt"}` |
| `GET /api/templates` | `{"data":[{"id","label","hint","icon"}],"source","fetchedAt"}` |
| `GET /api/catalog` | Modèles + rôles + défauts + source (`live` / `fallback`) |
| `GET /api/health` | État de la passerelle : `deployment` (plateforme, `sessionCapable`), `session`, `diagnostic` (cause en clair), catalogue, uptime |
| `POST /api/session/refresh` | Force un cookie neuf — réservé (`ADMIN_TOKEN`, en-tête `x-admin-token`) |

### Codes d'erreur

| Statut | `code` | Signification |
|---|---|---|
| `400` | `BAD_REQUEST`, `E4` | Payload refusé (modèle, rôle ou historique) |
| `401` | `SESSION` | Session Dolphin expirée — la passerelle se reconnecte |
| `429` | `RATE_LIMITED` | Limite locale atteinte (`Retry-After` fourni) |
| `502` | `UPSTREAM_5XX` | Dolphin en erreur |
| `403` | `CF_CHALLENGE` | Session existante invalidée par Cloudflare → rejeu automatique après rafraîchissement |
| `503` | `NO_BROWSER` | Plateforme sans navigateur (Vercel, Netlify, Lambda) : aucune session possible — voir [Déploiement Vercel](#-déploiement-vercel) |
| `503` | `NO_SESSION` | Aucune session disponible (cookie absent, solveur en échec) : la cause réelle est remontée au lieu d'un « challenge » générique |
| `503` | `SOLVER_UNAVAILABLE`, `SOLVER_FAILED`, `UPSTREAM_UNREACHABLE` | Impossible d'obtenir une session ou de joindre Dolphin |
| `504` | `TIMEOUT` | Amont muet |

## ☁️ Déploiement Render

**Option A — blueprint (recommandé).** Poussez le dépôt, puis *New → Blueprint* : `render.yaml` configure le service Docker, le health check et les variables d'environnement. Seul `ADMIN_TOKEN` vous est demandé (il n'entre jamais dans le repo).

**Option B — manuel.** *New → Web Service* → runtime **Docker** → `Dockerfile` à la racine → plan **Starter** (2 Go : Chromium consomme ~400 Mo) → health check `/api/health`.

> **Pourquoi Docker ?** `playwright install --with-deps chromium` a besoin d'être root pour installer les bibliothèques système de Chromium. C'est possible dans une image Docker, pas dans un build Node natif.

**Option C — Node natif** (si vous fournissez le cookie vous-même) : build `npm install && npx playwright install chromium`, start `npm start`, puis renseignez `DOLPHIN_COOKIE` (valide ~30 min — à réinjecter régulièrement). Pour un usage de production, préférez Docker.

## ▲ Déploiement Vercel

### Ce que Vercel peut faire — et ce qu'il ne peut pas

Vercel **héberge parfaitement l'interface** (`public/`, aucun build, CDN mondial : le [`vercel.json`](vercel.json) du dépôt sert exactement ça). En revanche, **le chat en mode réel ne peut pas fonctionner sur Vercel**, et *aucune variable d'environnement ne changera cela* :

| Blocage | Détail |
|---|---|
| **Pas de navigateur** | `npx playwright install` ne rentre pas dans le paquet d'une fonction Vercel (limite de taille). Sans moteur de rendu, le challenge Cloudflare ne peut pas être exécuté. |
| **IP de sortie instable** | `cf_clearance` est délivré à une empreinte **IP + User-Agent** : l'IP des fonctions change à chaque invocation, donc le cookie est invalidé à la requête suivante. |
| **Processus éphémère** | La session vit en mémoire du processus : rien n'est partagé entre deux invocations, la boucle de rafraîchissement (12 min) n'a pas de sens. |

C'est le sens de l'erreur `HTTP 403 · CF_CHALLENGE` accompagnée du badge gris « session en cours » : la passerelle n'a **aucun cookie** et n'a **aucun moyen d'en obtenir un**. Depuis cette version, Venice le dit explicitement (`503 NO_BROWSER`, badge rouge « session indisponible », champ `diagnostic` dans `/api/health`) au lieu de laisser croire qu'un rafraîchissement suffirait.

### Option A — interface sur Vercel, passerelle sur un conteneur (recommandé)

1. **Déployez la passerelle** là où Chromium peut vivre : Render ([`render.yaml`](render.yaml)), Docker, Fly.io, VPS… (voir [Déploiement Render](#-déploiement-render)).
2. **Déployez l'interface** sur Vercel : le projet sert `public/` tel quel, sans commande de build ni dépendances.
3. **Reliez les deux**, au choix :
   - **Réécriture Vercel** (aucune ligne de code à changer) — dans `vercel.json` :
     ```json
     "rewrites": [
       { "source": "/api/:path*", "destination": "https://votre-passerelle.onrender.com/api/:path*" }
     ]
     ```
     L'interface continue d'appeler `/api/...` en relatif, tout passe par le domaine Vercel.
   - **Appel direct** (sans proxy, si votre flux SSE est coupé par un intermédiaire) — dans `public/index.html` :
     ```html
     <meta name="venice-api-base" content="https://votre-passerelle.onrender.com" />
     ```
     puis, **côté passerelle** : `VENICE_ALLOWED_ORIGINS=https://votre-projet.vercel.app`.

### Option B — tout sur Vercel en mode démo

`DEMO_MODE=1` : l'interface complète (historique, thèmes, modèles, rôles, streaming simulé) fonctionne, les réponses sont générées localement. C'est le seul mode où « discuter » fonctionne sans passerelle.

```bash
vercel link          # une seule fois
npm run vercel:env   # pousse .env.vercel (DEMO_MODE=1, ADMIN_TOKEN…) vers Vercel
vercel --prod
```

### Le « fichier d'env » pour Vercel

Render se décrit avec un fichier versionné (`render.yaml`). Vercel n'a pas d'équivalent : `vercel.json` ne porte que le routing et le build (son champ `env` est un héritage déconseillé pour les secrets) et les variables se posent dans le dashboard… ou avec le pousseur fourni :

```bash
cp .env.vercel.example .env.vercel    # .env.vercel est ignoré par git
$EDITOR .env.vercel                   # ajustez les valeurs
npm run vercel:env                    # → production + preview + development
npm run vercel:env -- --dry           # aperçu, sans rien modifier
npm run vercel:env -- .env.vercel production
```

Le modèle [`.env.vercel.example`](.env.vercel.example) documente chaque variable et signale celles qui ne servent à rien sur Vercel. Le script [`scripts/vercel-env.mjs`](scripts/vercel-env.mjs) s'appuie sur la CLI Vercel (`npm i -g vercel`, `vercel link`) ; s'il ne la trouve pas, il affiche les paires à coller dans *Settings → Environment Variables*.

### Vérifier ce que dit le serveur

```bash
curl -s https://votre-projet.vercel.app/api/health | jq '.deployment, .diagnostic'
```

```json
{ "platform": "vercel", "serverless": true, "sessionCapable": false }
{ "level": "error", "code": "NO_BROWSER", "message": "…", "hint": "Hébergez la passerelle sur un conteneur…" }
```

## 🧪 Tests

```bash
npm test           # 25 tests : SSE, validation, session, intégration HTTP complète
npm run test:real  # vérification RÉELLE contre chat.dphn.ai (réseau + Chromium)
```

La suite couvre le parseur SSE, l'extraction tolérante des deltas, la validation des payloads,
les trois stratégies de prompt système, le cycle de vie du cookie (mutex, TTL, reprise après
challenge), le catalogue, le rate limit, le mode démo, les en-têtes de sécurité et la protection
contre la traversée de répertoires — le tout contre un **faux `chat.dphn.ai`** qui reproduit le
challenge Cloudflare (`403` + `cf-mitigated: challenge`) et le streaming SSE.

## 🔒 Sécurité & éthique

- **Aucun secret dans le dépôt.** Aucune clé d'API n'est nécessaire ; `.env` est ignoré par git.
- **En-têtes de sécurité** appliqués à toutes les réponses : `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`.
- **Validation stricte** des entrées (rôles, tailles, identifiants du catalogue), corps limité à 1 Mo, anti-traversée de répertoires.
- **Débit maîtrisé** : 30 requêtes/minute/IP par défaut — la passerelle n'inflige pas de charge anormale à `chat.dphn.ai`.
- **Usage** : cette passerelle sert à discuter avec un service public *via votre propre instance*. Respectez les conditions d'utilisation de `chat.dphn.ai` et n'en faites pas un usage abusif ou commercial non autorisé.

## 🩺 Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| Badge « session en cours » qui ne passe jamais à « connecté » | Chromium manquant ou challenge interactif | `npx playwright install --with-deps chromium`, puis vérifiez les logs `[cf]`. Si Turnstile s'affiche, injectez `DOLPHIN_COOKIE`. |
| **`HTTP 403 · CF_CHALLENGE` sur Vercel** | Vercel ne peut pas résoudre le challenge (pas de Chromium, IP de sortie instable) | Servez l'interface sur Vercel et hébergez la passerelle sur un conteneur, ou passez `DEMO_MODE=1` — voir [Déploiement Vercel](#-déploiement-vercel) |
| Badge rouge « session indisponible » | Cause définitive annoncée par `/api/health` (`diagnostic.code`) | Suivez `diagnostic.hint` : installer Chromium, injecter `DOLPHIN_COOKIE`, ou changer d'hébergeur |
| `503 NO_BROWSER` / `NO_SESSION` | Aucune session et aucun moyen d'en obtenir une sur cette plateforme | Hébergez la passerelle sur un conteneur, ou fournissez `DOLPHIN_COOKIE` |
| Erreurs CORS dans la console alors que l'interface est sur un autre domaine | Origine non autorisée par la passerelle | Sur la **passerelle** : `VENICE_ALLOWED_ORIGINS=https://votre-front.vercel.app` (ou utilisez la réécriture `/api/*`) |
| `503 SOLVER_UNAVAILABLE` | Playwright absent | `npm install` puis `npx playwright install --with-deps chromium` |
| `503 SOLVER_FAILED` (défi interactif) | Cloudflare durcit | Récupérez `cf_clearance` dans votre navigateur et posez `DOLPHIN_COOKIE` |
| Réponses lentes au premier message | Résolution du challenge au démarrage | `DOLPHIN_REFRESH_ON_BOOT=1` (défaut) préchauffe la session |
| `429 RATE_LIMITED` | Limite locale atteinte | `VENICE_RATE_LIMIT=60` (ou `0` pour désactiver) |
| Réponses tronquées | Flux amont coupé | `DOLPHIN_STREAM_IDLE_MS=120000`, `DOLPHIN_RETRIES=2` |
| « catalogue de secours » affiché | Amont injoignable | Vérifiez `/api/health` ; l'interface reste utilisable avec le catalogue embarqué |
| Erreur mémoire sur Render | Plan trop petit | Passez au plan Starter (2 Go) |

## 🗺️ Feuille de route

- [ ] Reprise d'une réponse interrompue (bouton *Continuer*)
- [ ] Export / import de l'historique en JSON
- [ ] Pièces jointes et modèles à vision (`vision: true` annoncé par l'API Dolphin)
- [ ] Recherche globale inter-conversations dans le tiroir d'historique
- [ ] Mise en cache partagée du cookie entre instances

## 📜 Crédits

- **Auteur** : Crazy Prince (`CrazyPrince12`) — Douala, Cameroun 🇨🇲
- **Amont** : [chat.dphn.ai](https://chat.dphn.ai/) (modèles dphn/Dolphin)
- **v1** : [`CrazyPrince12/Test`](https://github.com/CrazyPrince12/Test) — même interface, via Hugging Face Inference Providers
- **Licence** : MIT — voir [LICENSE](LICENSE)

<div align="center">

**Venice** — chat Dolphin, sans friction.

*Powered by Crazy Prince · From Cameroun* 🇨🇲

</div>
