/** Failure signals understood by the standalone retry policy. */
export type RetryFailure =
  | { kind: "transport"; error?: unknown; retryAfter?: string | null }
  | { kind: "http"; status: number; retryAfter?: string | null }
  | {
      kind: "json-rpc";
      code: number;
      retryable?: boolean;
      retryAfter?: string | null;
    }
  | {
      kind: "tool-result";
      isError: boolean;
      retryable?: boolean;
      retryAfter?: string | null;
    };

export interface RetryClassification {
  retryable: boolean;
  category: RetryFailure["kind"];
  reason: string;
  retryAfter?: string | null;
}

const DEFAULT_RETRYABLE_HTTP_STATUSES = new Set([
  401, 402, 408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Classify whether the failure itself is a retry signal. This does not decide
 * whether replaying the request is safe; use decideRetry for that decision.
 */
export function classifyRetryFailure(
  failure: RetryFailure,
  options: {
    retryableHttpStatuses?: readonly number[];
    retryableJsonRpcCodes?: readonly number[];
  } = {},
): RetryClassification {
  switch (failure.kind) {
    case "transport":
      return {
        retryable: true,
        category: failure.kind,
        reason: "transport failure",
        retryAfter: failure.retryAfter,
      };
    case "http": {
      const retryable = (options.retryableHttpStatuses
        ? new Set(options.retryableHttpStatuses)
        : DEFAULT_RETRYABLE_HTTP_STATUSES
      ).has(failure.status);
      return {
        retryable,
        category: failure.kind,
        reason: retryable
          ? `retryable HTTP ${failure.status}`
          : `non-retryable HTTP ${failure.status}`,
        retryAfter: failure.retryAfter,
      };
    }
    case "json-rpc": {
      const retryable = failure.retryable === true ||
        (failure.retryable !== false &&
          (options.retryableJsonRpcCodes || []).includes(failure.code));
      return {
        retryable,
        category: failure.kind,
        reason: retryable
          ? `retryable JSON-RPC error ${failure.code}`
          : `JSON-RPC error ${failure.code} is not retryable by default`,
        retryAfter: failure.retryAfter,
      };
    }
    case "tool-result": {
      const retryable = failure.isError && failure.retryable !== false;
      return {
        retryable,
        category: failure.kind,
        reason: failure.isError
          ? retryable
            ? "tool returned isError"
            : "tool error is not retryable"
          : "tool result is successful",
        retryAfter: failure.retryAfter,
      };
    }
  }
}

export interface RetryRequest {
  /** HTTP method, used only when no JSON-RPC method is supplied. */
  httpMethod?: string;
  rpcMethod?: string;
  toolName?: string;
  params?: unknown;
}

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
  reason: string;
  failure: RetryClassification;
}

const READ_ONLY_RPC_METHODS = new Set([
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "tasks/list",
  "tasks/get",
  "tasks/result",
]);

function toolNameFrom(request: RetryRequest): string | undefined {
  if (request.toolName) return request.toolName;
  if (!request.params || typeof request.params !== "object") return undefined;
  const name = (request.params as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

/** Only explicit MCP reads and caller-allowlisted read-only tools are replayable. */
export function isReplaySafeRequest(
  request: RetryRequest,
  readOnlyTools: readonly string[] = [],
): boolean {
  if (request.rpcMethod) {
    if (READ_ONLY_RPC_METHODS.has(request.rpcMethod)) return true;
    if (request.rpcMethod !== "tools/call") return false;
    const toolName = toolNameFrom(request);
    return Boolean(toolName && readOnlyTools.includes(toolName));
  }
  return ["GET", "HEAD", "OPTIONS"].includes(
    (request.httpMethod || "").toUpperCase(),
  );
}

/**
 * Parse Retry-After delta-seconds or an HTTP date. Values are clamped so a
 * remote response cannot make the caller wait longer than its local bound.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  options: { nowMs?: number; maxMs?: number } = {},
): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const maxMs = Number.isFinite(options.maxMs)
    ? Math.max(0, options.maxMs as number)
    : 30_000;
  const seconds = Number(value);
  let delayMs: number;
  if (Number.isFinite(seconds)) {
    if (seconds < 0) return undefined;
    delayMs = seconds * 1000;
  } else {
    const dateMs = Date.parse(value);
    if (!Number.isFinite(dateMs)) return undefined;
    delayMs = Math.max(0, dateMs - (options.nowMs ?? Date.now()));
  }
  return Math.min(delayMs, maxMs);
}

/**
 * Combine failure classification, replay safety, Retry-After and a total
 * elapsed-time deadline into one deterministic retry decision.
 */
export function decideRetry(input: {
  failure: RetryFailure;
  request: RetryRequest;
  elapsedMs: number;
  deadlineMs: number;
  readOnlyTools?: readonly string[];
  retryableHttpStatuses?: readonly number[];
  retryableJsonRpcCodes?: readonly number[];
  maxRetryAfterMs?: number;
  fallbackDelayMs?: number;
  nowMs?: number;
}): RetryDecision {
  const failure = classifyRetryFailure(input.failure, input);
  const no = (reason: string): RetryDecision => ({
    retry: false,
    delayMs: 0,
    reason,
    failure,
  });

  if (!failure.retryable) return no(failure.reason);
  if (!isReplaySafeRequest(input.request, input.readOnlyTools)) {
    return no("request is mutating or not explicitly known to be read-only");
  }
  if (!Number.isFinite(input.elapsedMs) || input.elapsedMs < 0 ||
      !Number.isFinite(input.deadlineMs) || input.deadlineMs <= input.elapsedMs) {
    return no("elapsed-time deadline reached");
  }

  const delayMs = failure.retryAfter != null
    ? parseRetryAfterMs(failure.retryAfter, {
        nowMs: input.nowMs,
        maxMs: input.maxRetryAfterMs,
      })
    : undefined;
  const effectiveDelay = delayMs ?? Math.max(0, input.fallbackDelayMs ?? 0);
  if (effectiveDelay >= input.deadlineMs - input.elapsedMs) {
    return no("retry delay would reach the elapsed-time deadline");
  }
  return {
    retry: true,
    delayMs: effectiveDelay,
    reason: "retryable failure and request is safe to replay",
    failure,
  };
}

export function mergeIncomingQuery(
  upstreamUrl: string | URL,
  incomingUrl: string | URL,
): URL {
  const target = new URL(upstreamUrl);
  const incoming = incomingUrl instanceof URL
    ? incomingUrl
    : new URL(incomingUrl, "http://token2oauth.local");
  incoming.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });
  return target;
}

const TASK_FOLLOWUP_METHODS = new Set([
  "tasks/get",
  "tasks/result",
  "tasks/cancel",
]);

export interface RpcRequestLike {
  method?: unknown;
  params?: unknown;
}

/** Return a task handle only for methods that follow up or cancel a task. */
export function taskIdFromFollowupRequest(request: unknown): string | undefined {
  if (!request || typeof request !== "object") return undefined;
  const rpc = request as RpcRequestLike;
  if (typeof rpc.method !== "string" || !TASK_FOLLOWUP_METHODS.has(rpc.method)) {
    return undefined;
  }
  if (!rpc.params || typeof rpc.params !== "object") return undefined;
  const taskId = (rpc.params as { taskId?: unknown }).taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

/** Recognize task handles in the standard MCP task result shape. */
export function taskIdFromResponse(response: unknown): string | undefined {
  if (!response || typeof response !== "object") return undefined;
  const result = (response as { result?: unknown }).result;
  if (!result || typeof result !== "object") return undefined;
  const record = result as { task?: unknown; taskId?: unknown };
  const task = record.task && typeof record.task === "object"
    ? (record.task as { taskId?: unknown }).taskId
    : undefined;
  const taskId = task ?? record.taskId;
  return typeof taskId === "string" && taskId.length > 0 ? taskId : undefined;
}

export type OwnershipBinding =
  | { ok: true; ownerAccountId: string }
  | { ok: false; ownerAccountId: string };

export type OwnershipResolution =
  | { kind: "none" }
  | { kind: "owner"; accountId: string; source: "session" | "task" }
  | { kind: "unknown-session"; sessionId: string }
  | { kind: "unknown-task"; taskId: string }
  | { kind: "conflict"; sessionOwner: string; taskOwner: string };

export type OwnershipAuthorization =
  | { allowed: true }
  | {
      allowed: false;
      reason: "unknown-session" | "unknown-task" | "ownership-conflict" | "foreign-owner";
      ownerAccountId?: string;
    };

/**
 * In-memory ownership index. Use it before pool strategy selection so every
 * strategy routes an existing session/task to its established upstream owner.
 *
 * Both maps are bounded LRUs: a long-running gateway must not grow without
 * limit as clients open sessions. Evicted handles simply become "unknown",
 * which callers treat like a handle seen for the first time.
 */
export class UpstreamOwnershipRegistry {
  private readonly sessions = new Map<string, string>();
  private readonly tasks = new Map<string, string>();
  private readonly capacity: number;

  constructor(options: { capacity?: number } = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 10_000));
  }

  bindSession(sessionId: string | undefined, accountId: string): OwnershipBinding | undefined {
    return this.bind(this.sessions, sessionId, accountId);
  }

  bindTask(taskId: string | undefined, accountId: string): OwnershipBinding | undefined {
    return this.bind(this.tasks, taskId, accountId);
  }

  sessionOwner(sessionId: string | undefined): string | undefined {
    return sessionId ? this.touch(this.sessions, sessionId) : undefined;
  }

  forgetSession(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  /** Drop every binding that points at an account (e.g. after it is removed). */
  forgetAccount(accountId: string): void {
    for (const owners of [this.sessions, this.tasks]) {
      for (const [handle, owner] of owners) if (owner === accountId) owners.delete(handle);
    }
  }

  size(): { sessions: number; tasks: number } {
    return { sessions: this.sessions.size, tasks: this.tasks.size };
  }

  private touch(owners: Map<string, string>, handle: string): string | undefined {
    const owner = owners.get(handle);
    if (owner !== undefined) {
      owners.delete(handle);
      owners.set(handle, owner);
    }
    return owner;
  }

  private bind(
    owners: Map<string, string>,
    handle: string | undefined,
    accountId: string,
  ): OwnershipBinding | undefined {
    if (!handle) return undefined;
    const current = this.touch(owners, handle);
    if (current) return { ok: current === accountId, ownerAccountId: current };
    owners.set(handle, accountId);
    while (owners.size > this.capacity) {
      const oldest = owners.keys().next().value;
      if (oldest === undefined) break;
      owners.delete(oldest);
    }
    return { ok: true, ownerAccountId: accountId };
  }

  resolve(input: { sessionId?: string; request?: unknown }): OwnershipResolution {
    const sessionOwner = input.sessionId
      ? this.touch(this.sessions, input.sessionId)
      : undefined;
    if (input.sessionId && !sessionOwner) {
      return { kind: "unknown-session", sessionId: input.sessionId };
    }
    const taskId = taskIdFromFollowupRequest(input.request);
    const taskOwner = taskId ? this.touch(this.tasks, taskId) : undefined;

    if (taskId && !taskOwner) return { kind: "unknown-task", taskId };
    if (sessionOwner && taskOwner && sessionOwner !== taskOwner) {
      return { kind: "conflict", sessionOwner, taskOwner };
    }
    if (taskOwner) return { kind: "owner", accountId: taskOwner, source: "task" };
    if (sessionOwner) return { kind: "owner", accountId: sessionOwner, source: "session" };
    return { kind: "none" };
  }

  authorize(accountId: string, resolution: OwnershipResolution): OwnershipAuthorization {
    if (resolution.kind === "none") return { allowed: true };
    if (resolution.kind === "unknown-session") {
      return { allowed: false, reason: "unknown-session" };
    }
    if (resolution.kind === "unknown-task") {
      return { allowed: false, reason: "unknown-task" };
    }
    if (resolution.kind === "conflict") {
      return { allowed: false, reason: "ownership-conflict" };
    }
    if (resolution.accountId !== accountId) {
      return {
        allowed: false,
        reason: "foreign-owner",
        ownerAccountId: resolution.accountId,
      };
    }
    return { allowed: true };
  }
}
