// catalog.js
// Catalogue de Venice : modèles et rôles (templates) du chat Dolphin.
//
// Le catalogue RÉEL est lu en direct sur https://chat.dphn.ai/api/models et
// /api/templates par lib/dolphin.js. Ce fichier fournit :
//   1. le catalogue de secours (relevé sur le site officiel, utilisé si la
//      passerelle est momentanément indisponible — le site reste utilisable) ;
//   2. les métadonnées d'affichage (libellés FR, descriptions, icônes SVG)
//      que l'API publique ne fournit pas ;
//   3. les fonctions de normalisation utilisées par le serveur et l'UI.

/** Identifiant du modèle par défaut (le 24B « Venice Edition » de Dolphin). */
export const DEFAULT_MODEL = "dolphinserver:24B";

/** Rôle par défaut. */
export const DEFAULT_TEMPLATE = "logical";

/**
 * Catalogue de secours — modèles actifs et fonctionnels de Dolphin.
 * Les checkpoints expérimentaux non fonctionnels (Alpha-200, Alpha-225) sont retirés.
 */
export const FALLBACK_MODELS = [
  {
    id: "dolphinserver:24B",
    label: "Dolphin 24B",
    vision: false,
    blurb: "Le modèle amiral : raisonnement long, code et rédaction au meilleur niveau.",
    tone: "flagship",
  },
  {
    id: "dolphinserver2:6b",
    label: "Dolphin X1 Nano",
    vision: false,
    blurb: "Ultra rapide et économe : idéal pour les questions courtes et l'itération.",
    tone: "fast",
  },
];

/** Modèles explicitement retirés car inopérants. */
export const EXCLUDED_MODEL_IDS = new Set([
  "dolphinserver3:trinity-mini-step200",
  "dolphinserver3:trinity-mini-step225",
]);

/**
 * Rôles (templates) de secours — relevés exacts de /api/templates le 2026-09-19.
 * `id` est la valeur envoyée à Dolphin, `label`/`hint` sont l'affichage Venice.
 */
export const FALLBACK_TEMPLATES = [
  { id: "logical", label: "Logique", hint: "Raisonnement structuré, réponses posées et précises." },
  { id: "creative", label: "Créatif", hint: "Écriture libre, idées, storytelling, brainstorming." },
  { id: "summary", label: "Synthèse", hint: "Résume et condense : l'essentiel en peu de lignes." },
  { id: "code-beginner", label: "Code débutant", hint: "Explications pas à pas, code commenté." },
  { id: "code-advanced", label: "Code avancé", hint: "Code dense, architecture, optimisation." },
];

/** Icônes (id du sprite SVG de l'interface) par rôle. */
const TEMPLATE_ICONS = {
  logical: "icon-brain",
  creative: "icon-spark",
  summary: "icon-lines",
  "code-beginner": "icon-code",
  "code-advanced": "icon-terminal",
};

function labelFromId(id) {
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Normalise un modèle renvoyé par l'API Dolphin (ou saisi à la main). */
export function normalizeModel(raw) {
  const id = typeof raw === "string" ? raw : raw?.id;
  if (!id || typeof id !== "string") return null;

  // Filtrer les modèles non fonctionnels
  if (
    EXCLUDED_MODEL_IDS.has(id) ||
    id.includes("step200") ||
    id.includes("step225") ||
    (typeof raw === "object" && (raw.label === "Alpha-200" || raw.label === "Alpha-225"))
  ) {
    return null;
  }

  const known = FALLBACK_MODELS.find((m) => m.id === id);
  const label =
    (typeof raw === "object" && typeof raw.label === "string" && raw.label.trim()) ||
    known?.label ||
    id.split(":").pop() ||
    id;
  return {
    id,
    label,
    vision: typeof raw === "object" ? Boolean(raw.vision) : Boolean(known?.vision),
    blurb:
      (typeof raw === "object" && typeof raw.blurb === "string" && raw.blurb) ||
      known?.blurb ||
      "Modèle servi par le chat Dolphin.",
    tone: known?.tone || "standard",
    default: id === DEFAULT_MODEL,
  };
}

/** Normalise un rôle (template) renvoyé par l'API Dolphin. */
export function normalizeTemplate(raw) {
  const id = typeof raw === "string" ? raw : raw?.name ?? raw?.id;
  if (!id || typeof id !== "string") return null;
  const known = FALLBACK_TEMPLATES.find((t) => t.id === id);
  return {
    id,
    label: known?.label || labelFromId(id),
    hint: known?.hint || "Rôle fourni par le chat Dolphin.",
    icon: TEMPLATE_ICONS[id] || "icon-spark",
    default: id === DEFAULT_TEMPLATE,
  };
}

/** Déduplique (en gardant l'ordre) une liste normalisée. */
function dedupe(list) {
  const seen = new Set();
  return list.filter((item) => {
    if (!item || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/** Construit le catalogue complet prêt à envoyer au navigateur. */
export function buildCatalog({ models, templates, source = "live", fetchedAt = Date.now() } = {}) {
  const listModels = dedupe((models ?? FALLBACK_MODELS).map(normalizeModel));
  const listTemplates = dedupe((templates ?? FALLBACK_TEMPLATES).map(normalizeTemplate));
  return {
    models: listModels.length ? listModels : FALLBACK_MODELS.map(normalizeModel),
    templates: listTemplates.length ? listTemplates : FALLBACK_TEMPLATES.map(normalizeTemplate),
    source,
    fetchedAt,
    defaultModel: listModels.some((m) => m.id === DEFAULT_MODEL) ? DEFAULT_MODEL : listModels[0]?.id,
    defaultTemplate: listTemplates.some((t) => t.id === DEFAULT_TEMPLATE)
      ? DEFAULT_TEMPLATE
      : listTemplates[0]?.id,
  };
}

/** Le catalogue de secours, déjà au format API. */
export const FALLBACK_CATALOG = buildCatalog({ source: "fallback" });
