/**
 * Experimental adapter for GitHub Copilot cloud-agent task REST endpoints.
 * GitHub documents these endpoints as public preview. This module is not wired
 * into Token2OAuth's runtime or credential store.
 */

export const GITHUB_AGENT_TASKS_API_VERSION = "2026-03-10";
export const GITHUB_AGENT_TASKS_API_ORIGIN = "https://api.github.com";

const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_TIMEOUT_MS = 30_000;

export type GithubAgentTaskOutcome = "not_sent" | "rejected" | "unknown";
export type GithubAgentTaskErrorCategory =
  | "auth" | "permission" | "not_found" | "validation" | "rate_limit"
  | "server" | "transport" | "protocol" | "response_too_large" | "unsupported";

export class GithubAgentTaskError extends Error {
  readonly name = "GithubAgentTaskError";

  constructor(
    readonly category: GithubAgentTaskErrorCategory,
    readonly requestOutcome: GithubAgentTaskOutcome,
    message: string,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface GithubAgentTaskRepository {
  owner: string;
  repo: string;
}

export interface GithubAgentTaskCredentialRequest extends GithubAgentTaskRepository {
  permission: "read" | "write";
}

/** Resolve a short-lived user-to-server or fine-grained PAT on each request. */
export type GithubAgentTaskCredentialResolver = (
  request: GithubAgentTaskCredentialRequest,
) => string | Promise<string>;

export interface GithubAgentTaskAdapterOptions {
  resolveCredential: GithubAgentTaskCredentialResolver;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export interface StartGithubAgentTaskInput {
  prompt: string;
  model?: string;
  custom_agent?: string;
  create_pull_request?: boolean;
  base_ref?: string;
  head_ref?: string;
}

export interface ListGithubAgentTasksOptions {
  page?: number;
  perPage?: number;
  state?: readonly string[];
  sort?: "updated_at" | "created_at";
  direction?: "asc" | "desc";
  isArchived?: boolean;
  since?: string;
}

export interface GithubAgentTaskArtifact {
  provider: "github";
  type: "pull" | "branch";
  data: { id: number; global_id?: string } | { head_ref: string; base_ref: string };
}

export interface GithubAgentTaskSummary {
  id: string;
  state: string;
  name?: string;
  url?: string;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  artifacts: GithubAgentTaskArtifact[];
}

export interface GithubAgentTaskList {
  tasks: GithubAgentTaskSummary[];
  total_active_count?: number;
  total_archived_count?: number;
}

const DOCUMENTED_STATES = new Set([
  "queued", "in_progress", "completed", "failed", "idle", "waiting_for_user", "timed_out", "cancelled",
]);

function invalid(label: string): never {
  throw new GithubAgentTaskError("validation", "not_sent", `${label} is invalid`);
}

function validateRepository(repository: GithubAgentTaskRepository): void {
  if (!repository || typeof repository !== "object") invalid("repository");
  // GitHub account names are 1–39 characters; repo names are at most 100.
  if (typeof repository.owner !== "string" || repository.owner.length > 39 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(repository.owner) || repository.owner.includes("--")) {
    invalid("repository owner");
  }
  if (typeof repository.repo !== "string" || repository.repo.length > 100 ||
      !/^[A-Za-z0-9._-]+$/.test(repository.repo) || repository.repo === "." || repository.repo === ".." ||
      repository.repo.startsWith(".") || repository.repo.endsWith(".")) {
    invalid("repository name");
  }
}

function validateTaskId(taskId: unknown): asserts taskId is string {
  if (typeof taskId !== "string" || taskId.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) {
    invalid("task ID");
  }
}

function validateBoundedText(value: unknown, label: string, max: number, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim().length === 0) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(value)) {
    invalid(label);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function optionalString(source: Record<string, unknown>, key: string, max = 512): string | undefined {
  const value = source[key];
  if (typeof value !== "string") return undefined;
  return value.slice(0, max);
}

function safeArtifact(value: unknown): GithubAgentTaskArtifact | undefined {
  const artifact = asRecord(value);
  if (!artifact || artifact.provider !== "github" || (artifact.type !== "pull" && artifact.type !== "branch")) return undefined;
  const data = asRecord(artifact.data);
  if (!data) return undefined;
  if (artifact.type === "pull" && Number.isSafeInteger(data.id) && (data.id as number) >= 0) {
    const globalId = typeof data.global_id === "string" ? data.global_id.slice(0, 256) : undefined;
    return { provider: "github", type: "pull", data: { id: data.id as number, ...(globalId === undefined ? {} : { global_id: globalId }) } };
  }
  if (artifact.type === "branch" && typeof data.head_ref === "string" && typeof data.base_ref === "string") {
    return { provider: "github", type: "branch", data: { head_ref: data.head_ref.slice(0, 256), base_ref: data.base_ref.slice(0, 256) } };
  }
  return undefined;
}

/** Keep only documented, bounded task status and review-artifact fields. */
function safeTask(value: unknown): GithubAgentTaskSummary {
  const task = asRecord(value);
  if (!task || typeof task.id !== "string" || task.id.length === 0 || task.id.length > 128 ||
      typeof task.state !== "string" || task.state.length > 64) {
    throw new GithubAgentTaskError("protocol", "rejected", "GitHub returned an invalid task representation");
  }
  // Preserve provider state verbatim. In particular, queued is not running.
  const artifacts = Array.isArray(task.artifacts)
    ? task.artifacts.slice(0, 50).map(safeArtifact).filter((item): item is GithubAgentTaskArtifact => item !== undefined)
    : [];
  return {
    id: task.id,
    state: task.state,
    ...(optionalString(task, "name", 512) === undefined ? {} : { name: optionalString(task, "name", 512) }),
    ...(optionalString(task, "url", 2048) === undefined ? {} : { url: optionalString(task, "url", 2048) }),
    ...(optionalString(task, "html_url", 2048) === undefined ? {} : { html_url: optionalString(task, "html_url", 2048) }),
    ...(optionalString(task, "created_at", 64) === undefined ? {} : { created_at: optionalString(task, "created_at", 64) }),
    ...(optionalString(task, "updated_at", 64) === undefined ? {} : { updated_at: optionalString(task, "updated_at", 64) }),
    artifacts,
  };
}

async function readBounded(response: Response): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new GithubAgentTaskError("response_too_large", "unknown", "GitHub response exceeded the configured size limit");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GithubAgentTaskError("response_too_large", "unknown", "GitHub response exceeded the configured size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

function classifyStatus(status: number, method: string): GithubAgentTaskError {
  const outcome: GithubAgentTaskOutcome = method === "POST" && status >= 500 ? "unknown" : "rejected";
  if (status === 401) return new GithubAgentTaskError("auth", outcome, "GitHub rejected authentication", status);
  if (status === 403) return new GithubAgentTaskError("permission", outcome, "GitHub denied the Agent tasks permission", status);
  if (status === 404) return new GithubAgentTaskError("not_found", outcome, "GitHub task or repository was not found", status);
  if (status === 422 || status === 400) return new GithubAgentTaskError("validation", outcome, "GitHub rejected the task request", status);
  if (status === 429) return new GithubAgentTaskError("rate_limit", outcome, "GitHub rate limited the task request", status);
  if (status >= 500) return new GithubAgentTaskError("server", outcome, "GitHub returned a server error", status);
  return new GithubAgentTaskError("protocol", outcome, "GitHub returned an unexpected HTTP status", status);
}

export class GithubAgentTasksAdapter {
  readonly experimental = true;
  readonly runtimeIntegration = "unverified" as const;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeoutMs: number;

  constructor(private readonly resolveCredential: GithubAgentTaskCredentialResolver, options: Omit<GithubAgentTaskAdapterOptions, "resolveCredential"> = {}) {
    if (typeof resolveCredential !== "function") throw new TypeError("credential resolver is required");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new TypeError("timeoutMs must be an integer from 1 to 30000");
    }
  }

  async start(repository: GithubAgentTaskRepository, input: StartGithubAgentTaskInput): Promise<GithubAgentTaskSummary> {
    validateRepository(repository);
    if (!input || typeof input !== "object") invalid("task input");
    validateBoundedText(input.prompt, "prompt", MAX_PROMPT_LENGTH);
    for (const key of ["model", "custom_agent", "base_ref", "head_ref"] as const) {
      if (input[key] !== undefined) validateBoundedText(input[key], key, 256);
    }
    if (input.create_pull_request !== undefined && typeof input.create_pull_request !== "boolean") invalid("create_pull_request");
    const body: Record<string, unknown> = {
      prompt: input.prompt,
      create_pull_request: input.create_pull_request ?? false,
    };
    for (const key of ["model", "custom_agent", "base_ref", "head_ref"] as const) {
      if (input[key] !== undefined) body[key] = input[key];
    }
    const payload = await this.request(repository, "POST", `/agents/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tasks`, "write", body, 201);
    return safeTask(payload);
  }

  async list(repository: GithubAgentTaskRepository, options: ListGithubAgentTasksOptions = {}): Promise<GithubAgentTaskList> {
    validateRepository(repository);
    const page = options.page ?? 1;
    const perPage = options.perPage ?? 30;
    if (!Number.isInteger(page) || page < 1 || page > 10_000) invalid("page");
    if (!Number.isInteger(perPage) || perPage < 1 || perPage > 100) invalid("perPage");
    if (options.sort !== undefined && options.sort !== "updated_at" && options.sort !== "created_at") invalid("sort");
    if (options.direction !== undefined && options.direction !== "asc" && options.direction !== "desc") invalid("direction");
    if (options.isArchived !== undefined && typeof options.isArchived !== "boolean") invalid("isArchived");
    const query = new URLSearchParams({ page: String(page), per_page: String(perPage) });
    if (options.sort !== undefined) query.set("sort", options.sort);
    if (options.direction !== undefined) query.set("direction", options.direction);
    if (options.isArchived !== undefined) query.set("is_archived", String(options.isArchived));
    if (options.since !== undefined) {
      validateBoundedText(options.since, "since", 64);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(options.since) || !Number.isFinite(Date.parse(options.since))) invalid("since");
      query.set("since", options.since);
    }
    if (options.state !== undefined) {
      if (!Array.isArray(options.state) || options.state.length < 1 || options.state.length > DOCUMENTED_STATES.size ||
          options.state.some((state) => typeof state !== "string" || !DOCUMENTED_STATES.has(state))) invalid("state");
      query.set("state", [...new Set(options.state)].join(","));
    }
    const path = `/agents/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tasks?${query.toString()}`;
    const payload = asRecord(await this.request(repository, "GET", path, "read", undefined, 200));
    if (!payload || !Array.isArray(payload.tasks)) throw new GithubAgentTaskError("protocol", "rejected", "GitHub returned an invalid task list");
    const tasks = payload.tasks.slice(0, perPage).map(safeTask);
    return {
      tasks,
      ...(Number.isSafeInteger(payload.total_active_count) ? { total_active_count: payload.total_active_count as number } : {}),
      ...(Number.isSafeInteger(payload.total_archived_count) ? { total_archived_count: payload.total_archived_count as number } : {}),
    };
  }

  async get(repository: GithubAgentTaskRepository, taskId: string): Promise<GithubAgentTaskSummary> {
    validateRepository(repository);
    validateTaskId(taskId);
    const path = `/agents/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tasks/${encodeURIComponent(taskId)}`;
    return safeTask(await this.request(repository, "GET", path, "read", undefined, 200));
  }

  async cancel(_repository: GithubAgentTaskRepository, _taskId: string): Promise<never> {
    throw new GithubAgentTaskError("unsupported", "not_sent", "GitHub documents no agent-task cancellation endpoint");
  }

  private async request(
    repository: GithubAgentTaskRepository,
    method: "GET" | "POST",
    path: string,
    permission: "read" | "write",
    body: Record<string, unknown> | undefined,
    expectedStatus: number,
  ): Promise<unknown> {
    let token: string;
    try {
      token = await this.resolveCredential({ owner: repository.owner, repo: repository.repo, permission });
    } catch {
      throw new GithubAgentTaskError("auth", "not_sent", "GitHub credential resolution failed");
    }
    if (typeof token !== "string" || token.length === 0 || token.length > 16_384 || /[\r\n]/.test(token)) {
      throw new GithubAgentTaskError("auth", "not_sent", "GitHub credential resolver returned an invalid credential");
    }
    const url = new URL(path, GITHUB_AGENT_TASKS_API_ORIGIN);
    if (url.origin !== GITHUB_AGENT_TASKS_API_ORIGIN) throw new GithubAgentTaskError("validation", "not_sent", "Unsafe GitHub API URL");
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_AGENT_TASKS_API_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new GithubAgentTaskError("transport", method === "POST" ? "unknown" : "not_sent", "GitHub request failed; response details were withheld");
    } finally {
      // Drop this local reference after the request; the resolver remains the only credential source.
      token = "";
    }
    if (response.status !== expectedStatus) throw classifyStatus(response.status, method);
    let text: string;
    try {
      text = await readBounded(response);
    } catch (error) {
      if (error instanceof GithubAgentTaskError) throw error;
      throw new GithubAgentTaskError("protocol", method === "POST" ? "unknown" : "rejected", "GitHub response could not be read");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GithubAgentTaskError("protocol", method === "POST" ? "unknown" : "rejected", "GitHub returned invalid JSON");
    }
  }
}
