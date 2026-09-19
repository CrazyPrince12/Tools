// sse.js — lecture et écriture de Server-Sent Events (zéro dépendance).
//
// Deux usages :
//   1. PARSER le flux SSE de Dolphin (/api/chat répond en chunks
//      `chat.completion.chunk`, format OpenAI) ;
//   2. ÉCRIRE notre propre flux SSE vers le navigateur, au format Venice :
//      `data: {"delta":"…"}` … `data: [DONE]`.
//
// Le parseur est volontairement tolérant : Dolphin est un service non
// documenté, on accepte donc plusieurs formes de trames.

/** Transforme un flux binaire en flux de chaînes (UTF-8 incrémental). */
export async function* decodeStream(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * Itère les événements SSE d'un flux HTTP.
 * @param {ReadableStream<Uint8Array>} body
 * @returns {AsyncGenerator<{event: string, data: string, id: string|null, raw: string}>}
 */
export async function* parseSSE(body) {
  let buffer = "";
  for await (const chunk of decodeStream(body)) {
    buffer += chunk;
    // Les trames SSE sont séparées par une ligne vide (\n\n ou \r\n\r\n).
    buffer = buffer.replace(/\r\n/g, "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      const event = parseEvent(raw);
      if (event) yield event;
    }
  }
  const tail = parseEvent(buffer);
  if (tail) yield tail;
}

/** Parse une trame SSE brute en objet structuré (ou null si vide). */
export function parseEvent(raw) {
  const lines = String(raw).split("\n");
  const data = [];
  let event = "message";
  let id = null;

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // commentaire / heartbeat CF
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") data.push(value);
    else if (field === "event") event = value;
    else if (field === "id") id = value;
  }

  if (!data.length) return null;
  return { event, data: data.join("\n"), id, raw };
}

/**
 * Extrait le texte d'une trame Dolphin, quelle que soit sa forme.
 *
 * Formes reconnues (par ordre de probabilité) :
 *   {"choices":[{"delta":{"content":"…"}}]}   ← standard OpenAI
 *   {"choices":[{"message":{"content":"…"}}]} ← réponse complète en un bloc
 *   {"choices":[{"text":"…"}]}                ← complétions texte
 *   {"delta":"…"} / {"token":"…"} / {"content":"…"} / {"response":"…"}
 *   {"response":"…"}                          ← style Ollama
 * @returns {string|null} le texte, ou null si la trame ne porte pas de contenu.
 */
export function extractDelta(payload) {
  if (payload === null || payload === undefined) return null;
  if (typeof payload === "string") return payload.length ? payload : null;

  const choice = Array.isArray(payload.choices) ? payload.choices[0] : null;
  if (choice) {
    const candidates = [
      choice.delta?.content,
      choice.message?.content,
      choice.text,
      choice.delta?.text,
      choice.content,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.length) return candidate;
    }
    if (choice.delta?.role && !choice.delta?.content) return null; // trame d'ouverture
  }

  for (const key of ["delta", "token", "content", "response", "text", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length) return value;
    if (key === "message" && value && typeof value.content === "string" && value.content.length) {
      return value.content;
    }
  }
  return null;
}

/** Détecte la sentinelle de fin de flux. */
export function isDone(data) {
  const value = String(data ?? "").trim();
  return value === "[DONE]" || value === "DONE" || value === "[done]";
}

/** Parse un `data:` JSON ; renvoie null si ce n'est pas du JSON exploitable. */
export function parseJsonData(data) {
  const value = String(data ?? "").trim();
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Sérialise une trame SSE côté serveur Venice. */
export function sseFrame(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** En-têtes d'un flux SSE (désactive le buffering des proxys). */
export const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};
