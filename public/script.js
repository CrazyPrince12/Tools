// script.js — interface de Venice (chatbot créé par Crazy Prince).
//
// Le navigateur ne connaît aucun secret : il appelle uniquement /api/*, c'est
// le serveur (la passerelle) qui parle au chat Dolphin avec sa session
// Cloudflare. Ce fichier gère :
//   • les conversations multiples, sauvegardées en localStorage ;
//   • le menu Historique (en haut à l'extrême gauche) ;
//   • les sélecteurs de modèle et de rôle (catalogue Dolphin en direct) ;
//   • le streaming SSE, le rendu formaté, le thème, les animations GSAP.

const BOT_NAME = "Venice";
const THEME_KEY = "venice.theme";
const STORE_KEY = "venice.store.v2";

/**
 * Base des appels API.
 * • Vide (défaut) : même origine — l'interface et la passerelle sont servies par
 *   le même domaine (local, Render, Docker, ou Vercel qui réécrit /api/*).
 * • Renseignée via <meta name="venice-api-base"> : l'interface est servie par
 *   un domaine et la passerelle par un autre (ex. UI sur Vercel + passerelle
 *   Chromium sur Render, sans réécriture). Côté passerelle, autorisez alors
 *   l'origine avec VENICE_ALLOWED_ORIGINS.
 */
const API_BASE = (document.querySelector('meta[name="venice-api-base"]')?.content || "")
  .trim()
  .replace(/\/+$/, "");

/** URL absolue d'une route de l'API (relative quand API_BASE est vide). */
function apiUrl(path) {
  return `${API_BASE}${path}`;
}

/** Fenêtre de contexte envoyée au serveur (derniers messages). */
let CONTEXT_WINDOW = 20;
/** Messages conservés par conversation dans le navigateur. */
let STORED_MESSAGES = 80;
/** Nombre maximal de conversations conservées localement. */
let MAX_CONVERSATIONS = 60;

const el = {
  chat: document.getElementById("chat"),
  messages: document.getElementById("messages"),
  emptyState: document.getElementById("emptyState"),
  greeting: document.getElementById("greeting"),
  emptyHint: document.getElementById("emptyHint"),
  form: document.getElementById("chatForm"),
  input: document.getElementById("userInput"),
  sendBtn: document.getElementById("sendBtn"),
  clearBtn: document.getElementById("clearChat"),
  newBtn: document.getElementById("newChat"),
  themeToggle: document.getElementById("themeToggle"),
  themeIcon: document.getElementById("themeIcon"),
  statusBadge: document.getElementById("statusBadge"),
  statusText: document.getElementById("statusText"),
  errorToast: document.getElementById("errorToast"),
  bubbles: document.getElementById("bubbles"),

  // Historique
  historyToggle: document.getElementById("historyToggle"),
  drawer: document.getElementById("historyDrawer"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  drawerClose: document.getElementById("drawerClose"),
  drawerNew: document.getElementById("drawerNew"),
  historyList: document.getElementById("historyList"),
  historySearch: document.getElementById("historySearch"),
  historyCount: document.getElementById("historyCount"),
  historyClearAll: document.getElementById("historyClearAll"),

  // Modèles / rôles
  modelSelect: document.getElementById("modelSelect"),
  templateSelect: document.getElementById("templateSelect"),
  templateHint: document.getElementById("templateHint"),
  templateIcon: document.getElementById("templateIconUse"),
  catalogSource: document.getElementById("catalogSource"),
  personaToggle: document.getElementById("personaToggle"),
  personaPanel: document.getElementById("personaPanel"),
  personaInput: document.getElementById("personaInput"),
  personaClear: document.getElementById("personaClear"),
};

let store = loadStore();
let catalog = { models: [], templates: [] };
let busy = false;
let toastTimer = null;

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function svgIcon(id, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", id === "icon-dolphin" ? "0 0 128 128" : "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${id}`);
  svg.append(use);
  return svg;
}

function formatTime(value) {
  const date = value instanceof Date ? value : new Date(Number(value) || Date.now());
  return date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

function formatDay(ts) {
  const date = new Date(Number(ts) || Date.now());
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a, b) => a.toDateString() === b.toDateString();
  if (sameDay(date, today)) return formatTime(ts);
  if (sameDay(date, yesterday)) return "hier";
  return date.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" });
}

function uid() {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/* ------------------------------------------------------------------ */
/* Persistance locale (navigateur de l'utilisateur, rien côté serveur) */
/* ------------------------------------------------------------------ */

function emptyStore() {
  return { version: 2, activeId: null, conversations: [] };
}

function normalizeMessage(message) {
  if (!message || typeof message.content !== "string") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  return {
    role: message.role,
    content: message.content,
    ts: Number.isFinite(message.ts) ? message.ts : Date.now(),
    ...(message.model ? { model: String(message.model) } : {}),
    ...(message.template ? { template: String(message.template) } : {}),
  };
}

function normalizeConversation(raw) {
  if (!raw || typeof raw !== "object") return null;
  const messages = Array.isArray(raw.messages)
    ? raw.messages.map(normalizeMessage).filter(Boolean).slice(-STORED_MESSAGES)
    : [];
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now();
  return {
    id: typeof raw.id === "string" && raw.id ? raw.id : uid(),
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim().slice(0, 90) : "",
    createdAt,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt,
    model: typeof raw.model === "string" ? raw.model : "",
    template: typeof raw.template === "string" ? raw.template : "",
    instructions: typeof raw.instructions === "string" ? raw.instructions.slice(0, 4000) : "",
    messages,
  };
}

function loadStore() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!parsed || typeof parsed !== "object") return emptyStore();
    const conversations = Array.isArray(parsed.conversations)
      ? parsed.conversations.map(normalizeConversation).filter(Boolean).slice(0, MAX_CONVERSATIONS)
      : [];
    return {
      version: 2,
      activeId: conversations.some((c) => c.id === parsed.activeId) ? parsed.activeId : null,
      conversations,
    };
  } catch {
    return emptyStore();
  }
}

let saveTimer = null;
function saveStore({ immediate = false } = {}) {
  const write = () => {
    try {
      const payload = {
        version: 2,
        activeId: store.activeId,
        conversations: store.conversations.slice(0, MAX_CONVERSATIONS).map((conversation) => ({
          ...conversation,
          messages: conversation.messages.slice(-STORED_MESSAGES),
        })),
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(payload));
    } catch {
      /* quota dépassé ou localStorage indisponible : on continue en mémoire */
    }
  };
  clearTimeout(saveTimer);
  if (immediate) write();
  else saveTimer = setTimeout(write, 350);
}

/* ------------------------------------------------------------------ */
/* Conversations                                                       */
/* ------------------------------------------------------------------ */

function activeConversation() {
  return store.conversations.find((conversation) => conversation.id === store.activeId) || null;
}

/** Renvoie la conversation active, ou en crée une vide si nécessaire. */
function ensureConversation() {
  let conversation = activeConversation();
  if (!conversation) {
    conversation = {
      id: uid(),
      title: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: store.lastModel || "",
      template: store.lastTemplate || "",
      instructions: "",
      messages: [],
    };
    store.conversations.unshift(conversation);
    store.activeId = conversation.id;
    saveStore();
  }
  return conversation;
}

function touchConversation(conversation) {
  conversation.updatedAt = Date.now();
  store.conversations = [conversation, ...store.conversations.filter((c) => c.id !== conversation.id)];
  saveStore();
}

function titleFrom(text) {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > 58 ? `${clean.slice(0, 58)}…` : clean || "Nouvelle conversation";
}

function conversationLabel(conversation) {
  return conversation.title || firstUserMessage(conversation) || "Nouvelle conversation";
}

function firstUserMessage(conversation) {
  return conversation.messages.find((message) => message.role === "user")?.content?.trim() || "";
}

function createConversation() {
  const previous = activeConversation();
  // Une conversation vide en tête de liste n'est pas dupliquée.
  if (previous && previous.messages.length === 0) {
    renderMessages();
    renderHistory();
    return previous;
  }
  const conversation = {
    id: uid(),
    title: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    model: el.modelSelect.value || store.lastModel || "",
    template: el.templateSelect.value || store.lastTemplate || "",
    instructions: "",
    messages: [],
  };
  store.conversations.unshift(conversation);
  store.activeId = conversation.id;
  saveStore({ immediate: true });
  syncEmptyState();
  animateEmptyState();
  renderMessages();
  renderHistory();
  renderPersona();
  autoResize();
  el.input.focus();
  return conversation;
}

function openConversation(id) {
  if (busy || id === store.activeId) {
    if (!busy) closeDrawer();
    return;
  }
  store.activeId = id;
  saveStore({ immediate: true });
  renderMessages();
  renderHistory();
  renderPersona();
  closeDrawer();
}

function deleteConversation(id) {
  if (busy) return;
  store.conversations = store.conversations.filter((conversation) => conversation.id !== id);
  if (store.activeId === id) store.activeId = store.conversations[0]?.id ?? null;
  saveStore({ immediate: true });
  renderMessages();
  renderHistory();
  renderPersona();
}

function clearAllConversations() {
  if (busy) return;
  store = emptyStore();
  saveStore({ immediate: true });
  renderMessages();
  renderHistory();
  renderPersona();
  renderGreeting();
  syncEmptyState();
  animateEmptyState();
}

function clearActiveConversation() {
  if (busy) return;
  const conversation = ensureConversation();
  conversation.messages = [];
  conversation.title = "";
  conversation.updatedAt = Date.now();
  saveStore({ immediate: true });
  renderMessages();
  renderHistory();
  hideToast();
  renderGreeting();
  syncEmptyState();
  animateEmptyState();
  el.input.value = "";
  autoResize();
  el.input.focus();
}

/* ------------------------------------------------------------------ */
/* Thème                                                               */
/* ------------------------------------------------------------------ */

function syncThemeIcon() {
  const deep = document.documentElement.dataset.theme !== "lagoon";
  el.themeIcon?.setAttribute("href", deep ? "#icon-sun" : "#icon-moon");
  const label = deep ? "Passer au thème lagon" : "Passer au thème abysses";
  el.themeToggle?.setAttribute("aria-label", label);
  el.themeToggle?.setAttribute("title", label);
}

el.themeToggle?.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "lagoon" ? "deep" : "lagoon";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignore */
  }
  syncThemeIcon();
});

/* ------------------------------------------------------------------ */
/* Message d'accueil selon l'heure                                     */
/* ------------------------------------------------------------------ */

const GREETINGS = [
  { start: 5, end: 12, options: ["Bonjour, bien réveillé ?", "Bonjour, prêt à attaquer la journée ?", "Salut ! On démarre du bon pied ?"] },
  { start: 12, end: 14, options: ["Bon appétit, on discute ?", "Bonjour, déjà midi ? Le temps file !"] },
  { start: 14, end: 18, options: ["L'après-midi avance bien ?", "Salut, belle après-midi ! Une question ?"] },
  { start: 18, end: 22, options: ["Bonsoir, comment se passe ta soirée ?", "Bonsoir ! On termine la journée en beauté ?"] },
  { start: 22, end: 24, options: ["Salut couche-tard, on veille ensemble ?", "Salut la nuit ! Qu'est-ce qu'on explore ?"] },
  { start: 0, end: 5, options: ["Encore debout ? Qu'est-ce qu'on fait ?", "Salut couche-tard, on plonge ?"] },
];

function getGreeting() {
  const hour = new Date().getHours();
  const bucket = GREETINGS.find((g) => hour >= g.start && hour < g.end) || GREETINGS[0];
  return bucket.options[(hour + bucket.start) % bucket.options.length];
}

function renderGreeting() {
  el.greeting.textContent = getGreeting();
}

/* ------------------------------------------------------------------ */
/* Rendu formaté des réponses (Markdown léger, 100 % DOM, zéro innerHTML) */
/* ------------------------------------------------------------------ */

function normalizeReply(text) {
  return String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|https?:\/\/[^\s<>()]+)/g;

function appendInline(parent, text) {
  const parts = String(text).split(INLINE_PATTERN);
  for (const part of parts) {
    if (!part) continue;
    if (/^\*\*[^*\n]+\*\*$/.test(part) || /^__[^_\n]+__$/.test(part)) {
      const strong = document.createElement("strong");
      strong.textContent = part.slice(2, -2);
      parent.append(strong);
    } else if (/^\*[^*\n]+\*$/.test(part) || /^_[^_\n]+_$/.test(part)) {
      const em = document.createElement("em");
      em.textContent = part.slice(1, -1);
      parent.append(em);
    } else if (/^`[^`\n]+`$/.test(part)) {
      const code = document.createElement("code");
      code.textContent = part.slice(1, -1);
      parent.append(code);
    } else if (/^\[[^\]\n]+\]\([^)\s]+\)$/.test(part)) {
      const match = part.match(/^\[([^\]\n]+)\]\(([^)\s]+)\)$/);
      parent.append(safeLink(match[2], match[1]));
    } else if (/^https?:\/\//.test(part)) {
      parent.append(safeLink(part, part));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}

function safeLink(href, label) {
  const url = String(href);
  if (!/^https?:\/\//i.test(url)) return document.createTextNode(label);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = label;
  return a;
}

function makeCodeBlock(language, code) {
  const wrap = document.createElement("div");
  wrap.className = "code-block";

  const head = document.createElement("div");
  head.className = "code-head";
  const lang = document.createElement("span");
  lang.textContent = language || "code";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-msg";
  copy.dataset.copyCode = "";
  copy.append(svgIcon("icon-copy"), document.createTextNode("Copier"));
  head.append(lang, copy);

  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code.replace(/\n$/, "");
  pre.append(codeEl);

  wrap.append(head, pre);
  return wrap;
}

function makeTable(rows) {
  const wrap = document.createElement("div");
  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const cells = rows.map((row) =>
    row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim())
  );

  const body = document.createElement("tbody");
  cells.forEach((row, index) => {
    const isSeparator = row.every((c) => /^:?-{2,}:?$/.test(c));
    if (isSeparator) return;
    const tr = document.createElement("tr");
    for (const cell of row) {
      const td = document.createElement(index === 0 ? "th" : "td");
      appendInline(td, cell);
      tr.append(td);
    }
    body.append(tr);
  });

  table.append(body);
  wrap.append(table);
  return wrap;
}

function renderFormatted(container, text) {
  container.replaceChildren();
  const lines = normalizeReply(text).split("\n");
  let i = 0;

  const flushList = (ordered, items) => {
    const list = document.createElement(ordered ? "ol" : "ul");
    for (const item of items) {
      const li = document.createElement("li");
      appendInline(li, item);
      list.append(li);
    }
    container.append(list);
  };

  while (i < lines.length) {
    const line = lines[i];

    // Bloc de code ```lang … ```
    const fence = line.match(/^\s*```\s*([\w+#-]*)\s*$/);
    if (fence) {
      const language = fence[1];
      const buffer = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        buffer.push(lines[i]);
        i += 1;
      }
      i += 1; // saute la clôture
      container.append(makeCodeBlock(language, buffer.join("\n")));
      continue;
    }

    // Ligne vide
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // Séparateur
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      container.append(document.createElement("hr"));
      i += 1;
      continue;
    }

    // Titre
    const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 4);
      const h = document.createElement(`h${level}`);
      appendInline(h, heading[2].replace(/\s*#+\s*$/, ""));
      container.append(h);
      i += 1;
      continue;
    }

    // Tableau
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i]);
        i += 1;
      }
      container.append(makeTable(rows));
      continue;
    }

    // Citation
    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const buffer = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buffer.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      appendInline(quote, buffer.join("\n"));
      container.append(quote);
      continue;
    }

    // Liste à puces
    if (/^\s*[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*•]\s+/, ""));
        i += 1;
      }
      flushList(false, items);
      continue;
    }

    // Liste numérotée
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
        i += 1;
      }
      flushList(true, items);
      continue;
    }

    // Paragraphe (lignes consécutives regroupées)
    const buffer = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*[-*•]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !/^\s*>\s?/.test(lines[i]) &&
      !/^\s*\|.*\|\s*$/.test(lines[i])
    ) {
      buffer.push(lines[i]);
      i += 1;
    }
    const p = document.createElement("p");
    appendInline(p, buffer.join("\n"));
    container.append(p);
  }

  if (!container.childNodes.length) {
    const p = document.createElement("p");
    p.textContent = normalizeReply(text);
    container.append(p);
  }
}

/* ------------------------------------------------------------------ */
/* Catalogue : modèles + rôles                                         */
/* ------------------------------------------------------------------ */

function labelForModel(id) {
  return catalog.models.find((model) => model.id === id)?.label || id || "Dolphin";
}

function labelForTemplate(id) {
  return catalog.templates.find((template) => template.id === id)?.label || id || "Logique";
}

async function loadCatalog() {
  try {
    const res = await fetch(apiUrl("/api/catalog"));
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error?.message || "Catalogue indisponible.");

    catalog = { models: data.models ?? [], templates: data.templates ?? [] };
    fillSelect(el.modelSelect, catalog.models, data.defaultModel);
    fillSelect(el.templateSelect, catalog.templates, data.defaultTemplate);

    const conversation = activeConversation();
    if (conversation?.model) el.modelSelect.value = conversation.model;
    if (conversation?.template) el.templateSelect.value = conversation.template;

    el.catalogSource.textContent =
      data.source === "live" ? "catalogue Dolphin en direct" : "catalogue de secours";
    el.catalogSource.classList.toggle("is-fallback", data.source !== "live");
    el.catalogSource.title =
      data.source === "live"
        ? "Modèles et rôles lus à l'instant sur chat.dphn.ai"
        : `Amont indisponible, catalogue embarqué utilisé${data.warning ? ` (${data.warning})` : ""}`;

    syncTemplateHint();
  } catch (error) {
    el.catalogSource.textContent = "catalogue indisponible";
    el.catalogSource.classList.add("is-fallback");
    showToast("Catalogue Dolphin indisponible", error.message);
  }
}

function fillSelect(select, items, fallbackId) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label;
    if (item.hint) option.title = item.hint;
    option.selected = item.id === fallbackId;
    select.append(option);
  }
  if (!items.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "aucun";
    select.append(option);
  }
}

function syncTemplateHint() {
  const template = catalog.templates.find((item) => item.id === el.templateSelect.value);
  el.templateHint.textContent = template?.hint || "";
  el.templateIcon?.setAttribute("href", `#${template?.icon || "icon-brain"}`);
}

el.templateSelect?.addEventListener("change", () => {
  const conversation = activeConversation();
  if (conversation && !busy) {
    conversation.template = el.templateSelect.value;
    touchConversation(conversation);
  }
  store.lastTemplate = el.templateSelect.value;
  saveStore();
  syncTemplateHint();
});

el.modelSelect?.addEventListener("change", () => {
  const conversation = activeConversation();
  if (conversation && !busy) {
    conversation.model = el.modelSelect.value;
    touchConversation(conversation);
  }
  store.lastModel = el.modelSelect.value;
  saveStore();
});

/* ------------------------------------------------------------------ */
/* Instructions personnalisées (persona de la conversation)            */
/* ------------------------------------------------------------------ */

function renderPersona() {
  const conversation = activeConversation();
  el.personaInput.value = conversation?.instructions || "";
  const open = !el.personaPanel.hidden;
  el.personaToggle.setAttribute("aria-expanded", String(open));
}

function togglePersona(force) {
  const open = force ?? el.personaPanel.hidden;
  el.personaPanel.hidden = !open;
  el.personaToggle.setAttribute("aria-expanded", String(open));
  if (open) {
    if (useGsap) gsap.from(el.personaPanel, { y: -8, opacity: 0, duration: 0.28, ease: "power2.out" });
    el.personaInput.focus();
  }
}

el.personaToggle?.addEventListener("click", () => togglePersona());

el.personaInput?.addEventListener("input", () => {
  const conversation = activeConversation();
  if (!conversation) return;
  conversation.instructions = el.personaInput.value.slice(0, 4000);
  saveStore({ immediate: true });
});

el.personaClear?.addEventListener("click", () => {
  el.personaInput.value = "";
  const conversation = activeConversation();
  if (conversation) {
    conversation.instructions = "";
    saveStore();
  }
});

/* ------------------------------------------------------------------ */
/* Construction des messages                                           */
/* ------------------------------------------------------------------ */

function buildMessage(role, content, options = {}) {
  const isBot = role === "assistant";
  const msg = document.createElement("div");
  msg.className = `msg msg-${isBot ? "bot" : "user"}`;
  msg.dataset.raw = content ?? "";

  const contentWrap = document.createElement("div");
  contentWrap.className = "msg-content";

  if (isBot) {
    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const roleSpan = document.createElement("span");
    roleSpan.className = "msg-role";
    roleSpan.textContent = BOT_NAME;

    const modelSpan = document.createElement("span");
    modelSpan.className = "msg-model";
    modelSpan.textContent = `${labelForModel(options.model || el.modelSelect.value)} · ${labelForTemplate(
      options.template || el.templateSelect.value
    )}`;

    const time = document.createElement("span");
    time.className = "msg-time";
    time.textContent = formatTime(options.ts);
    meta.append(roleSpan, modelSpan, time);
    contentWrap.append(meta);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  if (isBot) renderFormatted(bubble, content);
  else bubble.textContent = content;
  contentWrap.append(bubble);

  if (isBot && content) {
    const actions = document.createElement("div");
    actions.className = "msg-actions";
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "copy-msg";
    copy.dataset.copyMessage = "";
    copy.setAttribute("aria-label", "Copier le message");
    copy.append(svgIcon("icon-copy"), document.createTextNode("Copier"));
    actions.append(copy);
    contentWrap.append(actions);
  }

  const avatar = document.createElement("span");
  avatar.className = isBot ? "msg-avatar" : "msg-avatar msg-avatar-user";
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(svgIcon(isBot ? "icon-dolphin" : "icon-user", ""));

  if (isBot) msg.append(avatar, contentWrap);
  else msg.append(contentWrap, avatar);

  return msg;
}

function appendMessage(role, content, options = {}) {
  const msg = buildMessage(role, content, options);
  el.messages.append(msg);
  animateIn(msg, role);
  syncEmptyState();
  scrollToBottom(true);
  return msg;
}

function appendTyping() {
  removeTyping();
  const msg = document.createElement("div");
  msg.className = "msg msg-bot msg-typing";
  msg.id = "typingMessage";

  const avatar = document.createElement("span");
  avatar.className = "msg-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(svgIcon("icon-dolphin", ""));

  const contentWrap = document.createElement("div");
  contentWrap.className = "msg-content";

  const meta = document.createElement("div");
  meta.className = "msg-meta";
  const roleSpan = document.createElement("span");
  roleSpan.className = "msg-role";
  roleSpan.textContent = BOT_NAME;
  const modelSpan = document.createElement("span");
  modelSpan.className = "msg-model";
  modelSpan.textContent = `${labelForModel(el.modelSelect.value)} · ${labelForTemplate(
    el.templateSelect.value
  )}`;
  const time = document.createElement("span");
  time.className = "msg-time";
  time.textContent = formatTime();
  meta.append(roleSpan, modelSpan, time);

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  const label = document.createElement("span");
  label.textContent = `${BOT_NAME} réfléchit`;
  const dots = document.createElement("span");
  dots.className = "typing-dots";
  dots.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));
  bubble.append(label, dots);

  contentWrap.append(meta, bubble);
  msg.append(avatar, contentWrap);
  el.messages.append(msg);
  animateIn(msg, "assistant");
  scrollToBottom(true);
  return msg;
}

function removeTyping() {
  document.getElementById("typingMessage")?.remove();
}

function syncEmptyState() {
  const hasMessages = el.messages.children.length > 0;
  el.emptyState.hidden = hasMessages;
}

function scrollToBottom(force = false) {
  const chat = el.chat;
  const nearBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 200;
  if (force || nearBottom) {
    requestAnimationFrame(() => {
      if (typeof chat.scrollTo === "function") {
        chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" });
      } else {
        chat.scrollTop = chat.scrollHeight;
      }
    });
  }
}

/** Réaffiche entièrement la conversation active. */
function renderMessages() {
  el.messages.replaceChildren();
  const conversation = activeConversation();
  if (conversation) {
    for (const message of conversation.messages) {
      el.messages.append(
        buildMessage(message.role, message.content, {
          ts: message.ts,
          model: message.model || conversation.model,
          template: message.template || conversation.template,
        })
      );
    }
    if (conversation.model) el.modelSelect.value = conversation.model;
    if (conversation.template) el.templateSelect.value = conversation.template;
    syncTemplateHint();
  }
  syncEmptyState();
  requestAnimationFrame(() => {
    el.chat.scrollTop = el.chat.scrollHeight;
  });
}

/* ------------------------------------------------------------------ */
/* Animations GSAP (dégradation propre si le CDN n'est pas joignable)  */
/* ------------------------------------------------------------------ */

let gsap = window.gsap;
const motionOK = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
let useGsap = Boolean(gsap) && motionOK;

/** Le CDN GSAP peut se charger juste après le module : on retente au boot. */
function syncGsap() {
  if (!gsap && window.gsap) gsap = window.gsap;
  useGsap = Boolean(gsap) && motionOK;
}

function animateIn(node, role) {
  if (!useGsap) return;
  gsap.from(node, {
    opacity: 0,
    y: 18,
    x: role === "user" ? 18 : -18,
    duration: 0.45,
    ease: "power3.out",
  });
}

function initAnimations() {
  if (!useGsap) return;
  document.documentElement.classList.add("gsap-ready");

  gsap.from(".app-header", { y: -60, opacity: 0, duration: 0.7, ease: "power3.out" });
  gsap.from(".toolbar", { y: -24, opacity: 0, duration: 0.6, delay: 0.08, ease: "power3.out" });
  gsap.from(".composer", { y: 40, opacity: 0, duration: 0.7, delay: 0.1, ease: "power3.out" });
  gsap.from(".composer-note", { opacity: 0, duration: 0.6, delay: 0.35 });

  // Le dauphin nage doucement, comme en pleine mer.
  gsap.to(".brand-dolphin", { y: -3, rotate: -4, duration: 2.4, yoyo: true, repeat: -1, ease: "sine.inOut" });
  gsap.to(".empty-dolphin", { y: -14, rotate: 3, duration: 3.2, yoyo: true, repeat: -1, ease: "sine.inOut" });

  // Houle : trois vagues décalées.
  gsap.to(".wave-1", { xPercent: -18, duration: 18, yoyo: true, repeat: -1, ease: "sine.inOut" });
  gsap.to(".wave-2", { xPercent: -26, duration: 24, yoyo: true, repeat: -1, ease: "sine.inOut" });
  gsap.to(".wave-3", { xPercent: -12, duration: 30, yoyo: true, repeat: -1, ease: "sine.inOut" });

  spawnBubbles();
}

function animateEmptyState() {
  if (!useGsap) return;
  gsap.from(".empty-logo", { scale: 0.7, opacity: 0, duration: 0.8, ease: "back.out(1.7)" });
  gsap.from([".greeting", ".empty-sub", ".empty-hint"], {
    y: 20,
    opacity: 0,
    duration: 0.6,
    stagger: 0.1,
    ease: "power3.out",
  });
}

function spawnBubbles() {
  if (!useGsap || !el.bubbles) return;
  for (let i = 0; i < 16; i += 1) {
    const bubble = document.createElement("span");
    bubble.className = "bubble";
    const size = 4 + Math.random() * 16;
    bubble.style.width = `${size}px`;
    bubble.style.height = `${size}px`;
    bubble.style.left = `${Math.random() * 100}%`;
    el.bubbles.append(bubble);

    gsap.to(bubble, {
      y: -(window.innerHeight + 120),
      x: `random(-40, 40)`,
      opacity: 0.55,
      duration: 10 + Math.random() * 14,
      delay: Math.random() * 12,
      repeat: -1,
      ease: "none",
      onRepeat: () => {
        bubble.style.left = `${Math.random() * 100}%`;
      },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Historique (drawer)                                                 */
/* ------------------------------------------------------------------ */

function openDrawer() {
  el.drawer.hidden = false;
  el.drawerBackdrop.hidden = false;
  el.drawer.setAttribute("aria-hidden", "false");
  el.historyToggle.setAttribute("aria-expanded", "true");
  renderHistory();
  if (useGsap) {
    gsap.fromTo(el.drawer, { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.32, ease: "power3.out" });
    gsap.fromTo(el.drawerBackdrop, { opacity: 0 }, { opacity: 1, duration: 0.3 });
  }
  el.historySearch.focus({ preventScroll: true });
}

function closeDrawer() {
  if (el.drawer.hidden) return;
  const finish = () => {
    el.drawer.hidden = true;
    el.drawerBackdrop.hidden = true;
    el.drawer.setAttribute("aria-hidden", "true");
    el.historyToggle.setAttribute("aria-expanded", "false");
    el.historyToggle.focus({ preventScroll: true });
  };
  if (useGsap) {
    gsap.to(el.drawer, { x: -40, opacity: 0, duration: 0.22, ease: "power2.in", onComplete: finish });
    gsap.to(el.drawerBackdrop, { opacity: 0, duration: 0.22 });
  } else {
    finish();
  }
}

function toggleDrawer() {
  if (el.drawer.hidden) openDrawer();
  else closeDrawer();
}

el.historyToggle?.addEventListener("click", toggleDrawer);
el.drawerClose?.addEventListener("click", closeDrawer);
el.drawerBackdrop?.addEventListener("click", closeDrawer);
el.drawerNew?.addEventListener("click", () => {
  createConversation();
  closeDrawer();
});
el.historySearch?.addEventListener("input", renderHistory);
el.historyClearAll?.addEventListener("click", () => {
  if (!store.conversations.length) return;
  clearAllConversations();
  renderHistory();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !el.drawer.hidden) closeDrawer();
});

function renderHistory() {
  const query = el.historySearch.value.trim().toLowerCase();
  const conversations = [...store.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  el.historyList.replaceChildren();

  const matching = conversations.filter((conversation) => {
    if (!query) return true;
    if (conversationLabel(conversation).toLowerCase().includes(query)) return true;
    return conversation.messages.some((message) => message.content.toLowerCase().includes(query));
  });

  if (!matching.length) {
    const empty = document.createElement("li");
    empty.className = "history-empty";
    empty.textContent = query
      ? "Aucune conversation ne correspond."
      : "Aucune conversation enregistrée. Écris ton premier message !";
    el.historyList.append(empty);
  }

  for (const conversation of matching) {
    el.historyList.append(buildHistoryItem(conversation, query));
  }

  const total = store.conversations.length;
  el.historyCount.textContent = `${total} conversation${total > 1 ? "s" : ""}`;
  el.historyClearAll.disabled = total === 0;
}

function buildHistoryItem(conversation, query) {
  const item = document.createElement("li");
  item.className = "history-item";
  item.dataset.id = conversation.id;
  if (conversation.id === store.activeId) item.classList.add("is-active");

  const main = document.createElement("div");
  main.className = "history-main";

  const title = document.createElement("button");
  title.type = "button";
  title.className = "history-title";
  title.textContent = conversationLabel(conversation);
  title.title = conversationLabel(conversation);

  const sub = document.createElement("span");
  sub.className = "history-sub";
  const when = document.createElement("span");
  when.textContent = formatDay(conversation.updatedAt);
  const sep = document.createElement("span");
  sep.className = "sep";
  sep.textContent = "•";
  const count = document.createElement("span");
  const total = conversation.messages.length;
  count.textContent = `${total} message${total > 1 ? "s" : ""}`;
  const model = document.createElement("span");
  model.textContent = `${labelForModel(conversation.model)} · ${labelForTemplate(conversation.template)}`;
  sub.append(when, sep, count, sep.cloneNode(true), model);

  main.append(title, sub);
  item.append(main);

  if (query) {
    const preview = conversation.messages
      .find((message) => message.content.toLowerCase().includes(query))?.content;
    if (preview) {
      const excerpt = document.createElement("span");
      excerpt.className = "history-sub";
      const index = preview.toLowerCase().indexOf(query);
      excerpt.textContent = `…${preview.slice(Math.max(0, index - 20), index + 60).trim()}…`;
      main.append(excerpt);
    }
  }

  const actions = document.createElement("div");
  actions.className = "history-actions";

  const rename = document.createElement("button");
  rename.type = "button";
  rename.dataset.action = "rename";
  rename.title = "Renommer";
  rename.setAttribute("aria-label", `Renommer « ${conversationLabel(conversation)} »`);
  rename.append(svgIcon("icon-pen"));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.dataset.action = "delete";
  remove.title = "Supprimer";
  remove.setAttribute("aria-label", `Supprimer « ${conversationLabel(conversation)} »`);
  remove.append(svgIcon("icon-trash"));

  actions.append(rename, remove);
  item.append(actions);

  return item;
}

/** Ouvre une conversation ; délègue les actions renommer / supprimer. */
el.historyList?.addEventListener("click", (event) => {
  const item = event.target.closest(".history-item");
  if (!item) return;
  const id = item.dataset.id;

  const action = event.target.closest("button[data-action]")?.dataset.action;
  if (action === "delete") {
    deleteConversation(id);
    return;
  }
  if (action === "rename") {
    startRename(item, id);
    return;
  }
  openConversation(id);
});

function startRename(item, id) {
  const conversation = store.conversations.find((entry) => entry.id === id);
  if (!conversation) return;
  const titleButton = item.querySelector(".history-title");
  const input = document.createElement("input");
  input.className = "history-rename";
  input.value = conversationLabel(conversation);
  input.maxLength = 90;
  titleButton.replaceWith(input);
  input.focus();
  input.select();

  const commit = (save) => {
    if (save) {
      const value = input.value.trim().slice(0, 90);
      conversation.title = value || titleFrom(firstUserMessage(conversation));
      saveStore({ immediate: true });
    }
    renderHistory();
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      commit(false);
    }
  });
  input.addEventListener("blur", () => commit(true));
}

/* ------------------------------------------------------------------ */
/* État du serveur (badge)                                             */
/* ------------------------------------------------------------------ */

/** Dernier problème de session déjà annoncé (évite un toast toutes les minutes). */
let lastSessionProblem = null;

/**
 * Prévient une seule fois par cause : le message du serveur (message + conseil)
 * plutôt qu'un « challenge Cloudflare » générique.
 */
function notifySessionProblem(diagnostic) {
  if (!diagnostic?.code || lastSessionProblem === diagnostic.code) return;
  lastSessionProblem = diagnostic.code;
  showToast(diagnostic.message, diagnostic.hint || "Détails : /api/health");
}

async function refreshHealth() {
  try {
    const res = await fetch(apiUrl("/api/health"));
    const health = await res.json();
    el.statusBadge.classList.remove("status-loading", "status-ok", "status-demo", "status-error");

    // Les limites d'historique peuvent venir du serveur.
    if (health.history) {
      CONTEXT_WINDOW = health.history.contextWindow ?? CONTEXT_WINDOW;
      STORED_MESSAGES = health.history.storedMessages ?? STORED_MESSAGES;
      MAX_CONVERSATIONS = health.history.maxConversations ?? MAX_CONVERSATIONS;
    }

    // Le serveur explique lui-même l'état de la session (cause en clair).
    const diagnostic = health.diagnostic ?? health.session?.diagnostic ?? null;
    const sessionOk = Boolean(health.session?.hasCookie) && health.session?.state !== "stale";

    if (health.demoMode) {
      el.statusBadge.classList.add("status-demo");
      el.statusText.textContent = "mode démo";
      el.statusBadge.title = "Mode démo : réponses simulées, aucun appel à chat.dphn.ai.";
    } else if (sessionOk) {
      el.statusBadge.classList.add("status-ok");
      el.statusText.textContent = "connecté";
      el.statusBadge.title = diagnostic?.message || "Session Cloudflare active.";
    } else if (diagnostic?.level === "error") {
      // Cause DÉFINITIVE (plateforme sans navigateur, cookie absent…) : on le
      // dit clairement au lieu de laisser un badge gris « session en cours »
      // qui tourne indéfiniment sans jamais se connecter.
      el.statusBadge.classList.add("status-error");
      el.statusText.textContent = "session indisponible";
      el.statusBadge.title = [diagnostic.message, diagnostic.hint].filter(Boolean).join(" — ");
      notifySessionProblem(diagnostic);
    } else {
      el.statusBadge.classList.add("status-loading");
      el.statusText.textContent = "session en cours";
      el.statusBadge.title = diagnostic?.message || "État de la passerelle Dolphin";
    }

    el.emptyHint.textContent = health.demoMode
      ? "Mode démo : réponses simulées, interface complète."
      : diagnostic?.level === "error"
        ? diagnostic.message
        : `Modèles et rôles du chat Dolphin${health.upstream?.systemMode ? ` · session ${health.session?.state ?? "?"}` : ""}.`;
  } catch {
    el.statusBadge.classList.remove("status-loading", "status-ok", "status-demo");
    el.statusBadge.classList.add("status-error");
    el.statusText.textContent = "hors ligne";
  }
}

/* ------------------------------------------------------------------ */
/* Toast d'erreur                                                      */
/* ------------------------------------------------------------------ */

function showToast(message, action) {
  clearTimeout(toastTimer);
  el.errorToast.replaceChildren();

  const body = document.createElement("div");
  body.className = "toast-body";
  const title = document.createElement("strong");
  title.textContent = message;
  body.append(title);
  if (action) {
    const span = document.createElement("span");
    span.className = "toast-action";
    span.textContent = action;
    body.append(span);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Fermer");
  close.append(svgIcon("icon-close"));
  close.addEventListener("click", hideToast);

  el.errorToast.append(svgIcon("icon-alert"), body, close);
  el.errorToast.hidden = false;
  if (useGsap) gsap.from(el.errorToast, { y: 20, opacity: 0, duration: 0.3, ease: "power2.out" });
  toastTimer = setTimeout(hideToast, 9000);
}

function hideToast() {
  clearTimeout(toastTimer);
  el.errorToast.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Copie                                                               */
/* ------------------------------------------------------------------ */

async function copyText(text, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
  }

  const label = button.lastChild;
  if (label && label.nodeType === Node.TEXT_NODE) {
    const original = label.textContent;
    label.textContent = ok ? "Copié" : "Erreur";
    setTimeout(() => {
      label.textContent = original;
    }, 1600);
  }
}

document.addEventListener("click", (event) => {
  const codeBtn = event.target.closest("[data-copy-code]");
  if (codeBtn) {
    copyText(codeBtn.closest(".code-block")?.querySelector("code")?.textContent || "", codeBtn);
    return;
  }
  const msgBtn = event.target.closest("[data-copy-message]");
  if (msgBtn) {
    const msg = msgBtn.closest(".msg");
    copyText(msg?.dataset.raw || msg?.querySelector(".msg-bubble")?.textContent || "", msgBtn);
  }
});

/* ------------------------------------------------------------------ */
/* Envoi + streaming                                                   */
/* ------------------------------------------------------------------ */

function setBusy(state) {
  busy = state;
  el.sendBtn.disabled = state;
  el.sendBtn.setAttribute("aria-busy", state ? "true" : "false");
  el.modelSelect.disabled = state;
  el.templateSelect.disabled = state;
  el.clearBtn.disabled = state;
  el.newBtn.disabled = state;
}

function autoResize() {
  el.input.style.height = "auto";
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

function buildPayload(conversation) {
  return {
    messages: conversation.messages
      .slice(-CONTEXT_WINDOW)
      .map(({ role, content }) => ({ role, content })),
    model: el.modelSelect.value || undefined,
    template: el.templateSelect.value || undefined,
    instructions: conversation.instructions || undefined,
    stream: true,
  };
}

async function sendMessage(text) {
  if (!text || busy) return;

  const conversation = ensureConversation();
  const model = el.modelSelect.value || conversation.model;
  const template = el.templateSelect.value || conversation.template;
  conversation.model = model;
  conversation.template = template;

  const now = Date.now();
  conversation.messages.push({ role: "user", content: text, ts: now });
  if (!conversation.title) conversation.title = titleFrom(text);
  touchConversation(conversation);
  store.lastModel = model;
  store.lastTemplate = template;
  saveStore();

  const userMessageEl = appendMessage("user", text, { ts: now });
  setBusy(true);
  hideToast();
  appendTyping();
  renderHistory();

  let bubble = null;
  let streamWrap = null;
  let answer = "";

  const finishBubble = () => {
    if (!bubble) return;
    const msg = bubble.closest(".msg");
    msg?.classList.remove("streaming");
    if (msg) msg.dataset.raw = answer;
    renderFormatted(bubble, answer);
    const contentWrap = bubble.parentElement;
    if (contentWrap && !contentWrap.querySelector(".msg-actions")) {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "copy-msg";
      copy.dataset.copyMessage = "";
      copy.setAttribute("aria-label", "Copier le message");
      copy.append(svgIcon("icon-copy"), document.createTextNode("Copier"));
      actions.append(copy);
      contentWrap.append(actions);
    }
  };

  try {
    const res = await fetch(apiUrl("/api/chat"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload(conversation)),
    });

    const contentType = res.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      while (!done) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const chunk of events) {
          const dataLine = chunk.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) continue;
          const data = dataLine.slice(6);
          if (data === "[DONE]") {
            done = true;
            break;
          }
          let obj;
          try {
            obj = JSON.parse(data);
          } catch {
            continue; // trame partielle
          }
          if (obj.error) {
            throw Object.assign(new Error(obj.error.message), {
              detail: [obj.error.detail, obj.error.code].filter(Boolean).join(" · "),
            });
          }
          if (typeof obj.delta !== "string") continue;

          if (!bubble) {
            removeTyping();
            const msg = appendMessage("assistant", "", { ts: Date.now(), model, template });
            msg.classList.add("streaming");
            bubble = msg.querySelector(".msg-bubble");
            streamWrap = document.createElement("span");
            streamWrap.className = "stream-text";
            bubble.replaceChildren(streamWrap);
          }
          answer += obj.delta;
          streamWrap.textContent = answer;
          scrollToBottom();
        }
      }

      removeTyping();
      if (!answer.trim()) throw new Error("Réponse vide.");
      finishBubble();
      conversation.messages.push({ role: "assistant", content: answer, ts: Date.now(), model, template });
      touchConversation(conversation);
      saveStore({ immediate: true });
      renderHistory();
      scrollToBottom();
      return;
    }

    // Réponse JSON (mode non-stream ou erreur normalisée).
    let payload;
    try {
      payload = await res.json();
    } catch {
      throw new Error(`Erreur HTTP ${res.status}.`);
    }
    if (!res.ok || payload.error) {
      const e = payload.error ?? { message: "Erreur inconnue." };
      throw Object.assign(new Error(e.message), {
        detail: [e.detail, e.code].filter(Boolean).join(" · "),
      });
    }
    removeTyping();
    answer = payload.reply;
    conversation.messages.push({ role: "assistant", content: answer, ts: Date.now(), model, template });
    touchConversation(conversation);
    saveStore({ immediate: true });
    renderHistory();
    appendMessage("assistant", answer, { ts: Date.now(), model, template });
  } catch (error) {
    removeTyping();

    if (answer.trim()) {
      // Réponse partielle : on la garde, elle vaut mieux que rien.
      finishBubble();
      conversation.messages.push({ role: "assistant", content: answer, ts: Date.now(), model, template });
    } else {
      // Aucun contenu reçu : on retire la tentative et on rend le texte
      // à l'utilisateur pour qu'il n'ait pas à le retaper.
      bubble?.closest(".msg")?.remove();
      userMessageEl?.remove();
      const index = conversation.messages.findIndex((msg) => msg.ts === now && msg.role === "user");
      if (index !== -1) conversation.messages.splice(index, 1);
      if (!el.input.value.trim()) el.input.value = text;
    }
    touchConversation(conversation);
    saveStore({ immediate: true });
    renderHistory();
    syncEmptyState();
    showToast(error.message || "Une erreur est survenue.", error.detail || "");
  } finally {
    setBusy(false);
    autoResize();
    el.input.focus();
  }
}

/* ------------------------------------------------------------------ */
/* Événements                                                          */
/* ------------------------------------------------------------------ */

el.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const value = el.input.value.trim();
  if (!value) return;
  el.input.value = "";
  autoResize();
  sendMessage(value);
});

el.input.addEventListener("input", autoResize);

el.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    el.form.requestSubmit();
  }
});

el.clearBtn.addEventListener("click", clearActiveConversation);
el.newBtn.addEventListener("click", () => {
  createConversation();
  renderHistory();
});

/* ------------------------------------------------------------------ */
/* Initialisation                                                      */
/* ------------------------------------------------------------------ */

function init() {
  syncGsap();
  syncThemeIcon();
  renderGreeting();

  if (!store.activeId && store.conversations.length) store.activeId = store.conversations[0].id;
  renderMessages();
  renderHistory();
  renderPersona();
  if (store.lastModel && !activeConversation()?.model) el.modelSelect.value = store.lastModel;
  if (store.lastTemplate) el.templateSelect.value = store.lastTemplate;
  syncTemplateHint();

  syncEmptyState();
  autoResize();
  initAnimations();
  if (!el.messages.children.length) animateEmptyState();
  loadCatalog();
  refreshHealth();
  setInterval(refreshHealth, 60_000);
  el.input.focus();
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      el.chat.scrollTop = el.chat.scrollHeight;
    });
  });
}

init();
