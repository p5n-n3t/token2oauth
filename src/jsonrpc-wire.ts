/**
 * Helpers for reading MCP Streamable HTTP payloads, which arrive either as a
 * single `application/json` body or as a `text/event-stream` of JSON-RPC
 * messages. Parsing helpers are pure; readBodyLimited only consumes a body.
 */

import type { JsonRpcMessage } from "./tool-policy.js";

export interface ParsedClientPayload {
  payload: JsonRpcMessage | JsonRpcMessage[];
  messages: JsonRpcMessage[];
  batch: boolean;
}

/** Parse a client→server body. Returns undefined when it is not JSON-RPC. */
export function parseClientPayload(body: Buffer | undefined): ParsedClientPayload | undefined {
  if (!body || body.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isObject)) return undefined;
    return { payload: parsed as JsonRpcMessage[], messages: parsed as JsonRpcMessage[], batch: true };
  }
  if (!isObject(parsed)) return undefined;
  return { payload: parsed as JsonRpcMessage, messages: [parsed as JsonRpcMessage], batch: false };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SseEvent {
  /** Raw non-data field lines (event:, id:, retry:, comments) in original order. */
  fields: string[];
  data: string | undefined;
}

/** Split an SSE body into events. Tolerates CRLF and a missing trailing blank line. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n\n+/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const fields: string[] = [];
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      else if (line.length) fields.push(line);
    }
    events.push({ fields, data: data.length ? data.join("\n") : undefined });
  }
  return events;
}

export function serializeSse(events: SseEvent[]): string {
  return events
    .map((event) => {
      const lines = [...event.fields];
      if (event.data !== undefined) for (const line of event.data.split("\n")) lines.push("data: " + line);
      return lines.join("\n") + "\n\n";
    })
    .join("");
}

/** Every JSON-RPC message in a server→client body, whichever framing it uses. */
export function serverMessages(contentType: string | null, text: string): JsonRpcMessage[] {
  const out: JsonRpcMessage[] = [];
  const push = (value: unknown) => {
    if (Array.isArray(value)) value.filter(isObject).forEach((m) => out.push(m as JsonRpcMessage));
    else if (isObject(value)) out.push(value as JsonRpcMessage);
  };
  if ((contentType || "").toLowerCase().includes("text/event-stream")) {
    for (const event of parseSse(text)) {
      if (event.data === undefined) continue;
      try {
        push(JSON.parse(event.data));
      } catch {
        // Non-JSON data lines (keep-alives) carry no JSON-RPC message.
      }
    }
    return out;
  }
  try {
    push(JSON.parse(text));
  } catch {
    // Not JSON; nothing to report.
  }
  return out;
}

/**
 * Rewrite every JSON-RPC message in a server→client body with `fn`, keeping
 * the original framing. Returns undefined when the body cannot be parsed, so
 * callers can decide how to fail.
 */
export function rewriteServerBody(
  contentType: string | null,
  text: string,
  fn: (payload: JsonRpcMessage | JsonRpcMessage[]) => JsonRpcMessage | JsonRpcMessage[],
): string | undefined {
  if ((contentType || "").toLowerCase().includes("text/event-stream")) {
    const events = parseSse(text);
    for (const event of events) {
      if (event.data === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data);
      } catch {
        continue;
      }
      if (isObject(parsed) || Array.isArray(parsed)) {
        event.data = JSON.stringify(fn(parsed as JsonRpcMessage | JsonRpcMessage[]));
      }
    }
    return serializeSse(events);
  }
  try {
    const parsed = JSON.parse(text);
    if (!isObject(parsed) && !Array.isArray(parsed)) return undefined;
    return JSON.stringify(fn(parsed as JsonRpcMessage | JsonRpcMessage[]));
  } catch {
    return undefined;
  }
}

/** Read a fetch() body, giving up (undefined) once it exceeds `max` bytes. */
export async function readBodyLimited(response: globalThis.Response, max: number): Promise<Buffer | undefined> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}
