// messages.js — validation des requêtes de chat + préparation du payload amont.

import { DEFAULT_MODEL, DEFAULT_TEMPLATE } from "./config.js";

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

const ROLE_ALLOWLIST = new Set(["user", "assistant"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const TEMPLATE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/**
 * Valide le corps JSON de POST /api/chat et renvoie une version assainie.
 * @param {any} body
 * @param {object} [options]
 * @param {string[]} [options.models]    identifiants autorisés (catalogue amont)
 * @param {string[]} [options.templates] rôles autorisés (catalogue amont)
 * @param {object} [options.limits]      limites (cfg.limits)
 */
export function validateChatPayload(body, options = {}) {
  const limits = options.limits ?? {};
  const maxMessages = limits.maxMessages ?? 41;
  const maxMessageChars = limits.maxMessageChars ?? 8_000;
  const maxTotalChars = limits.maxTotalChars ?? 60_000;

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ValidationError("Le corps de la requête doit être un objet JSON.");
  }

  const { messages, model, template, stream, instructions } = body;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ValidationError('"messages" doit être un tableau non vide.');
  }
  if (messages.length > maxMessages) {
    throw new ValidationError(`Trop de messages (max ${maxMessages}).`);
  }

  let total = 0;
  const clean = messages.map((message, index) => {
    if (message === null || typeof message !== "object") {
      throw new ValidationError(`Message n°${index + 1} invalide.`);
    }
    if (!ROLE_ALLOWLIST.has(message.role)) {
      throw new ValidationError(`Message n°${index + 1} : rôle invalide ("user" ou "assistant").`);
    }
    if (typeof message.content !== "string" || !message.content.trim()) {
      throw new ValidationError(`Message n°${index + 1} : contenu vide.`);
    }
    if (message.content.length > maxMessageChars) {
      throw new ValidationError(
        `Message n°${index + 1} : trop long (max ${maxMessageChars} caractères).`
      );
    }
    total += message.content.length;
    return { role: message.role, content: message.content };
  });

  if (total > maxTotalChars) {
    throw new ValidationError(`Conversation trop longue (max ${maxTotalChars} caractères).`);
  }
  if (clean[clean.length - 1].role !== "user") {
    throw new ValidationError("Le dernier message doit venir de l'utilisateur.");
  }

  const cleanModel = normalizeId(model, ID_PATTERN, "model", options.models, DEFAULT_MODEL);
  const cleanTemplate = normalizeId(
    template,
    TEMPLATE_PATTERN,
    "template",
    options.templates,
    DEFAULT_TEMPLATE
  );

  let cleanInstructions;
  if (instructions !== undefined && instructions !== null && instructions !== "") {
    if (typeof instructions !== "string") {
      throw new ValidationError('"instructions" doit être une chaîne.');
    }
    if (instructions.length > 4_000) {
      throw new ValidationError('"instructions" trop long (max 4000 caractères).');
    }
    cleanInstructions = instructions.trim() || undefined;
  }

  return {
    messages: clean,
    model: cleanModel,
    template: cleanTemplate,
    instructions: cleanInstructions,
    stream: stream !== false, // streaming par défaut
  };
}

function normalizeId(value, pattern, field, allowed, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new ValidationError(`"${field}" invalide : "${String(value).slice(0, 40)}".`);
  }
  if (Array.isArray(allowed) && allowed.length && !allowed.includes(value)) {
    throw new ValidationError(`"${field}" inconnu : "${value}" n'est pas proposé par le catalogue.`);
  }
  return value;
}

/**
 * Construit le tableau de messages envoyé à Dolphin.
 *
 * Trois stratégies (le service amont n'étant pas documenté, on s'adapte) :
 *  - "system"  : un message {role:"system"} en tête ;
 *  - "message" : les consignes sont préfixées au dernier message utilisateur ;
 *  - "none"    : conversation brute, sans consignes.
 */
export function buildUpstreamMessages({ messages, systemPrompt, instructions, mode = "system" }) {
  const system = instructions
    ? `${systemPrompt}\n\n# DEMANDE PARTICULIÈRE POUR CETTE CONVERSATION\n${instructions}`
    : systemPrompt;

  if (mode === "message") {
    const copy = messages.map((message) => ({ ...message }));
    let index = copy.length - 1;
    while (index > 0 && copy[index].role !== "user") index -= 1;
    const target = copy[index];
    target.content = `[CONSIGNES SYSTÈME — à respecter pour toute la conversation]\n${system}\n\n---\n\n${target.content}`;
    return copy;
  }

  if (mode === "none") return messages.map((message) => ({ ...message }));

  return [{ role: "system", content: system }, ...messages.map((m) => ({ ...m }))];
}
