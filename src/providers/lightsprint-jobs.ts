import { createHash } from "node:crypto";
import { PROVIDER_PROFILES } from "../provider-capabilities.js";
import { readBodyLimited, serverMessages } from "../jsonrpc-wire.js";
import type { StateStore } from "../store.js";
import type { UpstreamAccount } from "../types.js";

export type JobProvider = "claude" | "codex" | "auto" | "pi";
export type JobClassification = "accepted" | "rejected" | "ambiguous";
export type JobReason = "auth" | "quota" | "rate_limit" | "not_found" | "account_unavailable" | "provider_mismatch" | "endpoint_mismatch" | "tool_error" | "protocol_error" | "transport_ambiguous" | "identity_mismatch" | "instructions_mismatch" | "response_too_large";

export interface JobResult<T = unknown> {
  classification: JobClassification;
  accountId: string;
  value?: T;
  reason?: JobReason;
  httpStatus?: number;
  /** A reported field only. LightSprint cannot be asked to use an exact model or branch. */
  reportedModel?: string;
  reportedBranchName?: string;
  instructionsVerified?: boolean;
}

export interface LightSprintMcpClient {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Optional local disposal; implementations must not send another request. */
  close?(): void | Promise<void>;
}

export interface LightSprintMcpClientOptions {
  endpoint: URL;
  token: string;
  fetch: typeof globalThis.fetch;
  timeoutMs: number;
}

export type LightSprintMcpClientFactory = (options: LightSprintMcpClientOptions) => LightSprintMcpClient | Promise<LightSprintMcpClient>;

export interface LightSprintJobsOptions {
  fetch?: typeof globalThis.fetch;
  clientFactory?: LightSprintMcpClientFactory;
  timeoutMs?: number;
}

const MAX_MCP_RESPONSE_BYTES = 1_048_576;
const MAX_TRANSCRIPT_CHARS = 250_000;
const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 500;
const MAX_INSTRUCTIONS_LENGTH = 20_000;
const MAX_MESSAGE_LENGTH = 50_000;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROVIDERS = new Set<JobProvider>(["claude", "codex", "auto", "pi"]);

class HttpStatusError extends Error {
  constructor(readonly status: number) { super("LightSprint HTTP response"); }
}
class ResponseTooLargeError extends Error {}
class AccountUnavailableError extends Error {
  constructor(readonly reason: "account_unavailable" | "provider_mismatch" | "endpoint_mismatch") { super("LightSprint account is not eligible"); }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length > MAX_ID_LENGTH || !ID_RE.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
}
function validateText(value: unknown, label: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0)) {
    throw new TypeError(`${label} is invalid`);
  }
}
function validateEndpoint(endpoint: URL): URL {
  const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl);
  if (endpoint.protocol !== "https:" || endpoint.origin !== expected.origin || endpoint.pathname !== "/mcp" ||
      endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("unsafe LightSprint MCP endpoint configuration");
  }
  return endpoint;
}

/** URL parser canonicalization permits equivalent spelling but no query, fragment, path, or authority variation. */
function isCanonicalNativeLightSprintUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const actual = new URL(value);
    const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl);
    return actual.protocol === "https:" && actual.hostname === expected.hostname && actual.port === "" &&
      actual.pathname === "/mcp" && !actual.username && !actual.password && !actual.search && !actual.hash &&
      actual.href === expected.href;
  } catch {
    return false;
  }
}

/** Streamable-HTTP client following this repository's JSON/SSE parser and session header conventions. */
export function createLightSprintMcpClient(options: LightSprintMcpClientOptions): LightSprintMcpClient {
  const endpoint = validateEndpoint(options.endpoint);
  let token = options.token;
  let nextId = 0;
  let sessionId: string | undefined;
  let initializePromise: Promise<void> | undefined;

  const post = async (message: Record<string, unknown>, notification = false): Promise<unknown> => {
    const headers = new Headers({
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    });
    if (sessionId) headers.set("mcp-session-id", sessionId);
    const response = await options.fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(options.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new HttpStatusError(response.status);
    const returnedSession = response.headers.get("mcp-session-id");
    if (returnedSession) sessionId = returnedSession;
    if (notification && (response.status === 202 || response.status === 204)) return undefined;
    const body = await readBodyLimited(response, MAX_MCP_RESPONSE_BYTES);
    if (body === undefined) throw new ResponseTooLargeError();
    const messages = serverMessages(response.headers.get("content-type"), body.toString("utf8"));
    const id = message.id;
    const matched = messages.find((item) => item.id === id);
    if (!matched) throw new Error("missing matching JSON-RPC response");
    if (matched.error) throw new JsonRpcFailure();
    return matched.result;
  };

  const ensureInitialized = (): Promise<void> => {
    if (!initializePromise) {
      initializePromise = (async () => {
        await post({
          jsonrpc: "2.0",
          id: ++nextId,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "token2oauth-lightsprint-jobs", version: "0.1.0" },
          },
        });
        await post({ jsonrpc: "2.0", method: "notifications/initialized" }, true);
      })();
    }
    return initializePromise;
  };

  return {
    async request(method, params = {}) {
      await ensureInitialized();
      return post({ jsonrpc: "2.0", id: ++nextId, method, params });
    },
    close() {
      // Drop local session and credential references; disposal performs no I/O.
      sessionId = undefined;
      token = "";
      initializePromise = undefined;
    },
  };
}

class JsonRpcFailure extends Error {}

function extractStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 5) return undefined;
  const obj = record(value);
  if (!obj) return undefined;
  for (const key of ["httpStatus", "statusCode", "status"]) {
    const status = obj[key];
    if (typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599) return status;
  }
  for (const child of Object.values(obj)) {
    const found = extractStatus(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}
function parseToolValue(raw: unknown): { value: unknown; isError: boolean; status?: number } {
  const obj = record(raw);
  const content = Array.isArray(obj?.content) ? obj.content : [];
  let parsedText: unknown;
  for (const part of content) {
    const text = record(part)?.text;
    if (typeof text !== "string") continue;
    try { parsedText = JSON.parse(text); break; } catch { /* retain only below */ }
  }
  const value = obj?.structuredContent ?? parsedText ?? raw;
  const status = extractStatus(value) ?? (parsedText === undefined ? undefined : extractStatus(parsedText));
  const payload = record(value);
  const isError = obj?.isError === true || Boolean(status) || Boolean(payload && ("error" in payload) && !("id" in payload));
  return { value, isError, status };
}
function reasonForStatus(status: number): JobReason {
  if (status === 401) return "auth";
  if (status === 402) return "quota";
  if (status === 429) return "rate_limit";
  if (status === 404) return "not_found";
  return "tool_error";
}
function findField(value: unknown, names: string[], depth = 0): unknown {
  if (depth > 6) return undefined;
  const obj = record(value);
  if (!obj) return undefined;
  for (const name of names) if (Object.hasOwn(obj, name)) return obj[name];
  for (const child of Object.values(obj)) {
    const found = findField(child, names, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
function boundedTranscript(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text.length <= MAX_TRANSCRIPT_CHARS) return value;
  return { truncated: true, preview: text.slice(0, MAX_TRANSCRIPT_CHARS) };
}
function accepted<T>(accountId: string, value: T): JobResult<T> {
  return { classification: "accepted", accountId, value };
}
function rejected<T = unknown>(accountId: string, reason: JobReason, httpStatus?: number): JobResult<T> {
  return { classification: "rejected", accountId, reason, ...(httpStatus ? { httpStatus } : {}) };
}

/** Account-pinned, no-failover adapter for the documented LightSprint MCP API. */
export class LightSprintJobsAdapter {
  private clientPromise?: Promise<LightSprintMcpClient>;
  private clientTokenDigest?: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly factory: LightSprintMcpClientFactory;
  private readonly timeoutMs: number;
  private readonly verifiedInstructions = new Map<string, string>();

  constructor(private readonly store: StateStore, readonly accountId: string, options: LightSprintJobsOptions = {}) {
    validateId(accountId, "accountId");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.factory = options.clientFactory ?? createLightSprintMcpClient;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) throw new RangeError("timeoutMs is invalid");
  }

  private async client(): Promise<LightSprintMcpClient> {
    const state = await this.store.load();
    const account: UpstreamAccount | undefined = state.accounts.find((item) => item.id === this.accountId);
    if (!account || account.enabled !== true) {
      this.clientPromise = undefined;
      this.clientTokenDigest = undefined;
      throw new AccountUnavailableError("account_unavailable");
    }
    const legacyNativeTarget = account.provider === "generic-bearer-mcp" && isCanonicalNativeLightSprintUrl(state.config.upstreamUrl);
    if (account.provider !== "lightsprint" && !legacyNativeTarget) {
      this.clientPromise = undefined;
      this.clientTokenDigest = undefined;
      throw new AccountUnavailableError(account.provider === "generic-bearer-mcp" ? "endpoint_mismatch" : "provider_mismatch");
    }
    const endpoint = validateEndpoint(new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl));
    const token = await this.store.revealToken(account);
    // There is no credential revision in PersistedState; compare a one-way
    // digest on every call and discard/rebuild a cached client after rotation.
    const tokenDigest = createHash("sha256").update(token).digest("hex");
    if (!this.clientPromise || this.clientTokenDigest !== tokenDigest) {
      const prior = this.clientPromise;
      this.clientTokenDigest = tokenDigest;
      const created = Promise.resolve(this.factory({ endpoint, token, fetch: this.fetchImpl, timeoutMs: this.timeoutMs }));
      this.clientPromise = created;
      if (prior) void prior.then((client) => client.close?.()).catch(() => undefined);
      try {
        return await created;
      } catch (error) {
        if (this.clientPromise === created) {
          this.clientPromise = undefined;
          this.clientTokenDigest = undefined;
        }
        throw error;
      }
    }
    return this.clientPromise;
  }

  private async api<T = unknown>(method: string, path: string, body?: Record<string, unknown>, transcript = false): Promise<JobResult<T>> {
    let raw: unknown;
    try {
      const client = await this.client();
      raw = await client.request("tools/call", {
        name: "lightsprint_api",
        arguments: { method, path, ...(body === undefined ? {} : { body }) },
      });
    } catch (error) {
      if (error instanceof HttpStatusError) return rejected<T>(this.accountId, reasonForStatus(error.status), error.status);
      if (error instanceof ResponseTooLargeError) return rejected<T>(this.accountId, "response_too_large");
      if (error instanceof JsonRpcFailure) return rejected<T>(this.accountId, "protocol_error");
      if (error instanceof AccountUnavailableError) return rejected<T>(this.accountId, error.reason);
      return { classification: "ambiguous", accountId: this.accountId, reason: "transport_ambiguous" };
    }
    const parsed = parseToolValue(raw);
    if (parsed.isError) {
      const status = parsed.status;
      return rejected<T>(this.accountId, status ? reasonForStatus(status) : "tool_error", status);
    }
    const value = transcript ? boundedTranscript(parsed.value) : parsed.value;
    return accepted(this.accountId, value as T);
  }

  createTask(title: string, stackId: string): Promise<JobResult> {
    validateText(title, "title", MAX_TITLE_LENGTH);
    validateId(stackId, "stackId");
    return this.api("POST", "/api/tasks", { title, scope: "stack", stackId });
  }

  readTask(taskId: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    return this.api("GET", `/api/tasks/${taskId}`);
  }

  async patchTaskInstructions(taskId: string, description: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    validateText(description, "description", MAX_INSTRUCTIONS_LENGTH);
    this.verifiedInstructions.delete(taskId);
    const patch = await this.api("PATCH", `/api/tasks/${taskId}`, { description });
    if (patch.classification === "rejected") return patch;
    // Even an ambiguous PATCH can only unlock launch after an independent, exact readback.
    const readback = await this.readTask(taskId);
    if (readback.classification !== "accepted") return readback;
    const returnedId = findField(readback.value, ["id", "taskId"]);
    const returnedDescription = findField(readback.value, ["description"]);
    if (returnedId !== taskId) return rejected(this.accountId, "identity_mismatch");
    if (returnedDescription !== description) return rejected(this.accountId, "instructions_mismatch");
    this.verifiedInstructions.set(taskId, description);
    return { ...accepted(this.accountId, readback.value), instructionsVerified: true };
  }

  async launchTask(taskId: string, provider: JobProvider, autoMerge = false): Promise<JobResult> {
    validateId(taskId, "taskId");
    if (!PROVIDERS.has(provider)) throw new TypeError("provider is invalid");
    if (autoMerge !== false) throw new TypeError("autoMerge must be false");
    const expected = this.verifiedInstructions.get(taskId);
    if (expected === undefined) return rejected(this.accountId, "instructions_mismatch");
    const before = await this.readTask(taskId);
    if (before.classification !== "accepted") return before;
    if (findField(before.value, ["id", "taskId"]) !== taskId || findField(before.value, ["description"]) !== expected) {
      this.verifiedInstructions.delete(taskId);
      return rejected(this.accountId, "instructions_mismatch");
    }
    const result = await this.api("POST", `/api/tasks/${taskId}/lightsprint-agents/${provider}`, { autoMerge: false });
    if (result.classification === "accepted") {
      const reportedModel = findField(result.value, ["model", "reportedModel"]);
      const reportedBranchName = findField(result.value, ["branchName"]);
      if (typeof reportedModel === "string") result.reportedModel = reportedModel;
      if (typeof reportedBranchName === "string") result.reportedBranchName = reportedBranchName;
    }
    return result;
  }

  listTaskAgents(taskId: string): Promise<JobResult> {
    validateId(taskId, "taskId");
    return this.api("GET", `/api/tasks/${taskId}/lightsprint-agents`);
  }

  sessionStatus(sessionId: string): Promise<JobResult> {
    validateId(sessionId, "sessionId");
    return this.api("GET", `/api/agent-sessions/${sessionId}/status`);
  }

  sessionTranscript(sessionId: string): Promise<JobResult> {
    validateId(sessionId, "sessionId");
    return this.api("GET", `/api/agent-sessions/${sessionId}/transcript`, undefined, true);
  }

  sendMessage(sessionId: string, message: string, clientMessageId: string): Promise<JobResult> {
    validateId(sessionId, "sessionId");
    validateText(message, "message", MAX_MESSAGE_LENGTH);
    if (typeof clientMessageId !== "string" || !CLIENT_MESSAGE_ID_RE.test(clientMessageId)) throw new TypeError("clientMessageId is invalid");
    return this.api("POST", `/api/agent-sessions/${sessionId}/chat`, { message, clientMessageId });
  }

  cancelTurn(sessionId: string): Promise<JobResult> {
    validateId(sessionId, "sessionId");
    return this.api("POST", `/api/agent-sessions/${sessionId}/cancel`, {});
  }

  stopSession(sessionId: string): Promise<JobResult> {
    validateId(sessionId, "sessionId");
    return this.api("POST", `/api/agent-sessions/${sessionId}/stop`, {});
  }
}
