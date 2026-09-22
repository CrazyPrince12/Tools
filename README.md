<div align="center">

<img src="public/assets/venice.svg" width="132" alt="Venice" />

# VENICE

**Les modèles et les rôles du chat Dolphin, dans une interface fluide.**
Passerelle Node.js auto-hébergée qui résout le challenge Cloudflare de [`chat.dphn.ai`](https://chat.dphn.ai/), rejoue la session comme un vrai navigateur et vous restitue le streaming token par token.

<p>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-20%2B-35e0d4?style=for-the-badge&logo=node.js&logoColor=04121f&labelColor=04121f" alt="Node 20+"></a>
  <a href="https://playwright.dev"><img src="https://img.shields.io/badge/Playwright-Chromium-2a8fe0?style=for-the-badge&logo=playwright&logoColor=04121f&labelColor=04121f" alt="Playwright"></a>
  <a href="https://neon.tech"><img src="https://img.shields.io/badge/Database-PostgreSQL%20Neon-00E599?style=for-the-badge&logo=postgresql&logoColor=04121f&labelColor=04121f" alt="Neon PostgreSQL"></a>
  <a href="https://render.com"><img src="https://img.shields.io/badge/Deploy-Render-46E3B7?style=for-the-badge&logo=render&logoColor=04121f&labelColor=04121f" alt="Render"></a>
  <a href="https://developer.mozilla.org/docs/Web/API/Server-sent_events"><img src="https://img.shields.io/badge/Stream-SSE-8ff7ea?style=for-the-badge&logo=serverless&logoColor=04121f&labelColor=04121f" alt="SSE"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/Licence-MIT-ff8a6b?style=for-the-badge&logo=opensourceinitiative&logoColor=04121f&labelColor=04121f" alt="MIT"></a>
  <a href="tests/venice.test.mjs"><img src="https://img.shields.io/badge/tests-29%20%2F%2029-38e0a5?style=for-the-badge&logo=nodedotjs&logoColor=04121f&labelColor=04121f" alt="Tests"></a>
</p>

Créé par **Crazy Prince** · Douala, Cameroun 🇨🇲 · Contact : [wa.me/+237694169177](https://wa.me/+237694169177)

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
| [Tests](#-tests) | [Sécurité & éthique](#-sécurité--éthique) |
| [Dépannage](#-dépannage) | [Feuille de route](#-feuille-de-route) |

## ✨ Démo & principes

| Principe | Traduction dans le code |
|---|---|
| **Aucune clé, aucun quota** | L'accès repose sur une session Cloudflare obtenue en pilotant un navigateur — pas sur un compte payant. |
| **Le navigateur ne connaît aucun secret** | Le front n'appelle que `/api/*` ; la session `cf_clearance` reste côté serveur. |
| **Dégradation élégante** | Le catalogue embarqué prend le relais si l'amont tombe, et l'interface reste complète en mode démo. |
| **Client raisonnable** | Rate limit par IP, cache du catalogue, rafraîchissements préventifs — on ne matraque pas l'amont. |
| **Persistance sécurisée** | Base PostgreSQL Neon (variable obligatoire `DATABASE_URL`) avec audit et surveillance du trafic. |

## 🚦 Voyant d'état (Signification des 3 Couleurs)

Pour offrir un maximum d'espace au titre **Venice par Crazy Prince** et garantir une parfaite responsive mobile, le long badge textuel a été remplacé par un voyant lumineux compact à 3 états :

| Couleur du voyant | Signification | Comportement |
|---|---|---|
| 🟢 **Vert** | **Connecté & Opérationnel** | La session Cloudflare est active (`warm`), la passerelle est prête à relayer immédiatement vos requêtes vers le chat Dolphin. |
| ⚪ **Gris** | **Session en cours / Initialisation** | La passerelle démarre, prépare le navigateur headless ou procède au rafraîchissement préventif du cookie de sécurité. |
| 🔴 **Rouge** | **Hors ligne / Erreur amont** | La passerelle ne parvient pas à joindre le serveur Dolphin ou le service amont rencontre une indisponibilité. |

Au survol du voyant, une infobulle native décrit textuellement l'état exact de la connexion.

## 🔐 Login / Sign-up Wall avec Chat Preview

Venice adopte le modèle moderne de **Login Wall avec Chat Preview** :
- Le site s'ouvre directement sur le chat. L'utilisateur peut explorer l'interface, consulter les modèles et rôles disponibles et taper son premier message dans la boîte de dialogue.
- Dès que l'utilisateur clique sur Envoyer (ou appuie sur Entrée), le mur de connexion / inscription fluide s'affiche au premier plan sans perdre le message rédigé.
- Données demandées à l'inscription :
  - **Pseudo** (nom ou pseudo d'affichage)
  - **Où il a entendu parler de Venice pour la première fois** (*heard_from*)
  - **user_name sans espace** (identifiant strict)
  - **Adresse e-mail**
  - **Mot de passe** (sécurisé avec salage bcrypt)
- À la connexion, l'utilisateur peut indifféremment utiliser son **e-mail** ou son **user_name**.
- Les sessions sont configurées pour rester **actives pendant 90 jours consécutifs** afin d'éviter toute reconnexion intempestive même après plusieurs jours sans ouvrir le navigateur.

## 🛡️ Panneau d'Administration (`/admin`) & Surveillance du Trafic

Venice relayant une IA sans filtre ni censure (*uncensored AI*), un tableau de bord d'administration complet est dédié à la surveillance responsable du trafic et au management des utilisateurs :
- **Supervision du trafic** : volume de requêtes, estimation des tokens consommés, graphiques par modèle et par rôle, canaux de découverte.
- **Gestion des utilisateurs** : liste exhaustive des comptes inscrits avec dates, métriques d'activité et statuts.
- **Modération active** : options instantanées pour **bannir** ou **suspendre** un utilisateur (bloquant immédiatement ses interactions avec le chat).
- **Messages d'alerte personnalisés** : l'administrateur peut envoyer un message spécifique qui s'affichera sous forme de bannière d'alerte prioritaire dans le chat de l'utilisateur ciblé.
- **Historique et audit complet** : inspection des prompts et réponses échangés pour surveiller tout comportement abusif.
- **Protection stricte** : la route `/admin` est verrouillée côté serveur. Toute tentative d'accès non autorisée redirige directement vers le chat principal.

### 🔑 Identifiants Administrateur
Les identifiants d'accès au compte administrateur sont stockés dans le fichier `admin-credentials.json` à la racine :
- **User name** : `CrazyPrince`
- **Email** : `francisvoufo@gmail.com`
- **Mot de passe** : `CRAZY237`

Pour vous connecter au panneau d'administration, utilisez simplement ces identifiants sur la page de connexion habituelle du site. Vous serez automatiquement reconnu comme administrateur et dirigé vers `/admin`.

## 🔧 Fonctionnalités

- **Chat streaming** — tokens relayés au fil de l'eau (`text/event-stream`), avec curseur de frappe et repli JSON.
- **Modèles Dolphin opérationnels** — `Dolphin 24B` (modèle amiral) et `Dolphin X1 Nano` (rapide et léger). Les checkpoints inopérants `Alpha-200` et `Alpha-225` ont été retirés.
- **Tous les rôles Dolphin** — `Logique`, `Créatif`, `Synthèse`, `Code débutant`, `Code avancé` (lus sur `/api/templates`).
- **Responsive mobile optimisée** — suppression adaptative des libellés textuels "Modèles" et "Rôles" sur petit écran pour laisser place aux icônes et ajustement strict de la largeur des sélecteurs.
- **Espace Profil dans l'Historique** — affichage de l'avatar personnalisé, informations du compte, compteur de requêtes, badge de statut, bouton d'accès admin et déconnexion.
- **Signature CrazyPrince** — mention *"Made with 💜 by CrazyPrince"* ouvrant directement WhatsApp ([wa.me/+237694169177](https://wa.me/+237694169177)).
- **Instructions personnalisées** — un prompt additionnel par conversation, injecté côté serveur.
- **Menu Historique** (extrême gauche du header) — conversations multiples, recherche plein texte, renommage, suppression, « tout effacer », tout en `localStorage`.
- **Rendu formaté** — titres, listes, tableaux, citations, blocs de code avec bouton *Copier*, liens sécurisés. Construit en DOM pur, jamais `innerHTML`.
- **Empreinte visuelle Venice** — océan animé (GSAP), thèmes *abysses* / *lagon*, voyant d'état lumineux, accueil selon l'heure, footer Cameroun.
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
   Render        │  validation · rate limit · cache catalogue · SSE         │
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

## 🧰 Stack technique

| Couche | Technologies |
|---|---|
| **Runtime** | Node.js 20+ (ESM, zéro framework HTTP), `node:test` |
| **Contournement Cloudflare** | Playwright · Chromium headless · contexte navigateur réaliste |
| **Transport** | `fetch` natif (undici), Server-Sent Events, parsing incrémental UTF-8 |
| **Frontend** | HTML5 sémantique · CSS3 (Grid, Flexbox, `color-mix`, thèmes) · JavaScript vanille · GSAP 3 · SVG sprite (aucun emoji) |
| **Persistance** | `localStorage` (conversations, thème) — côté navigateur uniquement |
| **Config** | Variables d'environnement (Render) · `.env` maison zéro dépendance |
| **Déploiement** | Docker (`node:22-bookworm-slim`) · Render Blueprint (`render.yaml`) |
| **Qualité** | 25 tests `node:test` (unitaires + intégration HTTP) · faux `chat.dphn.ai` intégré |

## 📁 Structure du projet

```
.
├── server.js              Serveur HTTP : statique + routes /api + boucle de session
├── index.js               Entrée générique (Render exécute « node index.js »)
├── config.js              Configuration centralisée (lue depuis l'environnement)
├── Dockerfile             Image de production (Chromium + dépendances système)
├── render.yaml            Blueprint Render (runtime Docker)
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
    ├── venice.test.mjs    Suite node:test (25 tests)
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

Toutes les variables sont documentées dans le fichier [`.env.example`](.env.example).
Sur **Render**, `DATABASE_URL` est obligatoire pour connecter votre instance PostgreSQL Neon.

| Variable | Défaut | Rôle |
|---|---|---|
| `DATABASE_URL` | *Obligatoire sur Render* | Chaîne de connexion PostgreSQL Neon (ex: `postgresql://user:pass@ep-xyz.neon.tech/neondb?sslmode=require`) |
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
| `GET /api/health` | État de la passerelle : session CF, catalogue, uptime, limites d'historique |
| `POST /api/session/refresh` | Force un cookie neuf — réservé (`ADMIN_TOKEN`, en-tête `x-admin-token`) |

### Codes d'erreur

| Statut | `code` | Signification |
|---|---|---|
| `400` | `BAD_REQUEST`, `E4` | Payload refusé (modèle, rôle ou historique) |
| `401` | `SESSION` | Session Dolphin expirée — la passerelle se reconnecte |
| `429` | `RATE_LIMITED` | Limite locale atteinte (`Retry-After` fourni) |
| `502` | `UPSTREAM_5XX` | Dolphin en erreur |
| `503` | `SOLVER_UNAVAILABLE`, `SOLVER_FAILED`, `UPSTREAM_UNREACHABLE` | Impossible d'obtenir une session ou de joindre Dolphin |
| `504` | `TIMEOUT` | Amont muet |

## ☁️ Déploiement Render

**Option A — blueprint (recommandé).** Poussez le dépôt, puis *New → Blueprint* : `render.yaml` configure le service Docker, le health check et les variables d'environnement. Seul `ADMIN_TOKEN` vous est demandé (il n'entre jamais dans le repo).

**Option B — manuel.** *New → Web Service* → runtime **Docker** → `Dockerfile` à la racine → plan **Starter** (2 Go : Chromium consomme ~400 Mo) → health check `/api/health`.

> **Pourquoi Docker ?** `playwright install --with-deps chromium` a besoin d'être root pour installer les bibliothèques système de Chromium. C'est possible dans une image Docker, pas dans un build Node natif.

**Option C — Node natif** (si vous fournissez le cookie vous-même) : build `npm install && npx playwright install chromium`, start `npm start`, puis renseignez `DOLPHIN_COOKIE` (valide ~30 min — à réinjecter régulièrement). Pour un usage de production, préférez Docker.

## 💾 Persistance des comptes (survit aux PR, commits et redéploiements)

Le disque d'un service Render est **éphémère** : à chaque déploiement (commit, merge de PR,
redémarrage, voire suppression/recréation du service), le système de fichiers repart de zéro.
C'est pourquoi la règle suivante s'applique :

> **La base de données de référence est PostgreSQL externe (Neon), via la variable `DATABASE_URL`.**
> Les comptes, sessions et messages y sont stockés — pas sur le disque du service.

Concrètement, cela garantit que :

- un **commit ou une PR qui redéploie** ne supprime aucun compte ;
- un **redémarrage** du service ne déconnecte personne ;
- **supprimer le service Render et le redéployer** fonctionne : la base Neon vit en dehors de
  Render, le nouveau service s'y reconnecte et retrouve **exactement les mêmes utilisateurs**,
  qui restent **connectés** (leurs sessions de 90 jours sont dans la base).

### Mise en place (une fois pour toutes)

1. Créez une base gratuite sur [neon.tech](https://neon.tech) (ou Render Postgres).
2. Copiez l'URL de connexion (elle ressemble à
   `postgresql://neondb_owner:…@ep-…-pooler.…neon.tech/neondb?sslmode=require`).
3. Dans Render : *Environment → Add environment variable* → `DATABASE_URL` = cette URL.
   Le schéma (`users`, `sessions`, `messages`) est créé automatiquement au démarrage.

### Filet de sécurité intégré ("zéro perte")

Si la base devient momentanément injoignable (cold-start, coupure réseau), le serveur **ne perd
rien** et **ne déconnecte personne** :

1. au démarrage, la connexion est **retentée 5 fois** avec backoff (un cold-start Neon lent ne
   fait plus basculer le service en mode fichier local) ;
2. si la base reste injoignable, le service continue en **mode dégradé** (visible dans
   `/api/health` → `storage.mode: "local-degraded"`) ;
3. dès que la base revient, tout ce qui a été créé entre-temps (comptes, sessions, messages) est
   **synchronisé automatiquement** vers PostgreSQL, sans jamais écraser de données existantes ;
4. si le service redémarre avant la reconnexion, le **tampon local est synchronisé au boot**
   suivant — rien ne disparaît.

### Sessions « restent connectées »

- Cookie `venice_session` **persistant 90 jours** (`HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS),
  renvoyé à chaque connexion/inscription.
- **Session glissante** : chaque activité prolonge automatiquement la session de 90 jours (dès
  qu'il reste moins de 60 jours) et renouvelle le cookie. Un utilisateur qui revient au moins une
  fois tous les deux mois ne se reconnecte **jamais** — même après de longues inactivités du
  navigateur.
- Les sessions vivent **dans la base** : elles survivent aux redéploiements.
- Côté navigateur, une erreur temporaire du serveur (503/base injoignable) **ne déconnecte
  jamais** : la session est conservée et revalidée plus tard.

> ⚠️ Sans `DATABASE_URL` en production, le serveur affiche un avertissement explicite au
> démarrage et les comptes ne survivront pas au déploiement suivant — vérifiez `/api/health`
> (`storage.mode` doit valoir `"postgres"`).

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
| « Compte introuvable » après un déploiement | `DATABASE_URL` absent ou injoignable au boot : les comptes étaient partis dans le fichier local éphémère | Renseignez `DATABASE_URL` (Neon) dans Render ; vérifiez `/api/health` → `storage.mode` doit valoir `"postgres"` ; recréez les comptes manquants (le compte admin est toujours recréé automatiquement) |
| `/api/health` affiche `storage.mode: "local-degraded"` | Neon momentanément injoignable | Rien à faire : reconnexion automatique (~30 s) et synchronisation des données créées entre-temps ; vérifiez l'URL dans Render si ça persiste |
| Badge « session en cours » qui ne passe jamais à « connecté » | Chromium manquant ou challenge interactif | `npx playwright install --with-deps chromium`, puis vérifiez les logs `[cf]`. Si Turnstile s'affiche, injectez `DOLPHIN_COOKIE`. |
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
