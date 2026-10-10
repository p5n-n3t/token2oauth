import { createHash } from "node:crypto";
import { spawn as nodeSpawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StateStore } from "./store.js";
import type { JobToolName } from "./job-submit.js";
import { JobInputError } from "./job-submit.js";
import { SupervisorBridge, type SupervisorBridgeOptions } from "./supervisor-bridge.js";
import type { SupervisorBackend, SupervisorCaller } from "./supervisor-api.js";

const MODEL = "gpt-6-luna";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_CONFIG = 64 * 1024;

type RegisteredSession = { sessionId: string; accountId: string; model: typeof MODEL };
type ProjectPolicy = { projectId: string; clientIds: string[]; accountIds: string[]; registeredSessions: RegisteredSession[] };
export interface SupervisorRuntimeConfig {
  version: 1;
  projects: ProjectPolicy[];
  maxWorkers: number;
  allowUnknownQuota: true;
  localLimits: { maxTasks: number; maxJobBytes: number; maxOutputBytes: number };
}
export interface SupervisorRuntimeOptions {
  configPath: string;
  configDir: string;
  supervisorCwd?: string;
  store: StateStore;
  bridgeOptions?: Partial<SupervisorBridgeOptions>;
}

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value); }
function assertKeys(value: Record<string, unknown>, keys: string[], where: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Invalid supervisor config fields: ${where}`);
}

/** Parse strict, private operator configuration; config cannot name executables or env overrides. */
export async function readSupervisorRuntimeConfig(path: string): Promise<SupervisorRuntimeConfig> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile() || (typeof process.getuid === "function" && info.uid !== process.getuid()) || (info.mode & 0o077) !== 0 || info.size > MAX_CONFIG) {
    throw new Error("Supervisor config must be a private, owner-only regular file no larger than 64 KiB");
  }
  const raw: unknown = JSON.parse(await readFile(absolute, "utf8"));
  if (!object(raw)) throw new Error("Supervisor config must be an object");
  assertKeys(raw, ["version", "projects", "maxWorkers", "allowUnknownQuota", "localLimits"], "root");
  if (raw.version !== 1 || raw.allowUnknownQuota !== true || !Number.isInteger(raw.maxWorkers) || Number(raw.maxWorkers) < 1 || Number(raw.maxWorkers) > 8 || !Array.isArray(raw.projects) || !object(raw.localLimits)) throw new Error("Invalid supervisor config");
  assertKeys(raw.localLimits, ["maxTasks", "maxJobBytes", "maxOutputBytes"], "localLimits");
  if (!Number.isInteger(raw.localLimits.maxTasks) || Number(raw.localLimits.maxTasks) < 1 || Number(raw.localLimits.maxTasks) > 100 ||
      !Number.isInteger(raw.localLimits.maxJobBytes) || Number(raw.localLimits.maxJobBytes) < 1024 || Number(raw.localLimits.maxJobBytes) > 1_048_576 ||
      !Number.isInteger(raw.localLimits.maxOutputBytes) || Number(raw.localLimits.maxOutputBytes) < 1 || Number(raw.localLimits.maxOutputBytes) > 32_768) throw new Error("Supervisor limits exceed supported bounds");
  const projects: ProjectPolicy[] = raw.projects.map((candidate: unknown): ProjectPolicy => {
    if (!object(candidate)) throw new Error("Invalid project policy");
    assertKeys(candidate, ["projectId", "clientIds", "accountIds", "registeredSessions"], "project");
    const projectId = candidate.projectId;
    const rawClientIds = candidate.clientIds;
    const rawAccountIds = candidate.accountIds;
    const rawSessions = candidate.registeredSessions;
    if (!safeId(projectId) || !Array.isArray(rawClientIds) || !rawClientIds.length || !rawClientIds.every(safeId) || new Set(rawClientIds).size !== rawClientIds.length || !Array.isArray(rawAccountIds) || !rawAccountIds.length || rawAccountIds.length > 50 || !rawAccountIds.every(safeId) || new Set(rawAccountIds).size !== rawAccountIds.length || !Array.isArray(rawSessions)) throw new Error("Invalid project bindings");
    const clientIds = rawClientIds as string[];
    const accountIds = rawAccountIds as string[];
    const registeredSessions: RegisteredSession[] = rawSessions.map((item: unknown): RegisteredSession => {
      if (!object(item)) throw new Error("Invalid registered session");
      assertKeys(item, ["sessionId", "accountId", "model"], "registeredSession");
      const sessionId = item.sessionId;
      const accountId = item.accountId;
      if (!safeId(sessionId) || !safeId(accountId) || !accountIds.includes(accountId) || item.model !== MODEL) throw new Error("Registered sessions must be bound to an eligible account and gpt-6-luna");
      return { sessionId, accountId, model: MODEL };
    });
    if (new Set(registeredSessions.map((item) => item.sessionId)).size !== registeredSessions.length) throw new Error("Duplicate registered session");
    return { projectId, clientIds, accountIds, registeredSessions };
  });
  if (!projects.length || new Set(projects.map((item) => item.projectId)).size !== projects.length) throw new Error("Supervisor config needs unique projects");
  return { version: 1, projects, maxWorkers: Number(raw.maxWorkers), allowUnknownQuota: true,
    localLimits: { maxTasks: Number(raw.localLimits.maxTasks), maxJobBytes: Number(raw.localLimits.maxJobBytes), maxOutputBytes: Number(raw.localLimits.maxOutputBytes) } };
}

function configuredProject(config: SupervisorRuntimeConfig, caller: SupervisorCaller): ProjectPolicy {
  const project = config.projects.find((item) => item.projectId === caller.projectId && item.clientIds.includes(caller.clientId));
  if (!project) throw new JobInputError("project is not authorized for this OAuth client");
  return project;
}
function parseJson(body: unknown): Record<string, unknown> {
  if (!body) return {};
  if (object(body)) return body;
  try { const encoded = typeof body === "string" ? body : Buffer.from(body as Uint8Array).toString("utf8"); const value: unknown = JSON.parse(encoded); return object(value) ? value : {}; }
  catch { throw new Error("invalid_supervisor_response"); }
}
function boundedJson(value: unknown, max = 1_048_576): unknown {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized) > max) throw new JobInputError("supervisor response exceeds configured bounds");
  return value;
}

export class SupervisorRuntime implements SupervisorBackend {
  private readonly bridge: SupervisorBridge;
  private closed = false;

  constructor(private readonly config: SupervisorRuntimeConfig, private readonly options: SupervisorRuntimeOptions) {
    const spawnChild = options.bridgeOptions?.spawnChild ?? ((function (command: string, args?: readonly string[], spawnOptions?: any) {
      // The Python socket is created with this inherited umask, so it is private
      // from its first visible inode (before the bridge's chmod verification).
      if (!args || args[0] !== "-m" || args[1] !== "snooze.bridge") throw new Error("Unexpected supervisor command");
      const code = "import os,runpy,sys; os.umask(0o077); sys.argv=['snooze.bridge',*sys.argv[1:]]; runpy.run_module('snooze.bridge',run_name='__main__')";
      return nodeSpawn(command, ["-c", code, ...args.slice(2)], spawnOptions);
    }) as typeof nodeSpawn);
    this.bridge = new SupervisorBridge({ enabled: true, configDir: options.configDir, supervisorCwd: options.supervisorCwd ?? resolve(process.cwd(), "supervisor"), ...options.bridgeOptions, spawnChild });
  }

  async start(): Promise<void> {
    const state = await this.options.store.load();
    for (const project of this.config.projects) for (const accountId of project.accountIds) {
      const account = state.accounts.find((row) => row.id === accountId);
      if (!account || account.provider !== "lightsprint" || !account.enabled) throw new Error("Configured supervisor account is unavailable");
    }
    await this.bridge.start();
    // R21's current operation claim does not return the task instruction packet
    // or registered session; R22 would consume and reject such a claim. The
    // durable worker is intentionally not started until that contract is fixed.
  }

  get status() { return this.bridge.status(); }

  async callTool(name: JobToolName, args: unknown, caller: SupervisorCaller): Promise<unknown> {
    if (this.closed) throw new Error("supervisor_closed");
    const project = configuredProject(this.config, caller);
    if (!object(args)) throw new JobInputError("invalid tool arguments");
    if (name === "job_submit") {
      const accounts = args.eligibleAccountIds;
      if (!Array.isArray(accounts) || accounts.some((id) => !project.accountIds.includes(id))) throw new JobInputError("eligible accounts are outside this project binding");
      if (accounts.length < 2) throw new JobInputError("the current durable scheduler requires at least two eligible accounts");
      const tasks = args.tasks;
      if (!Array.isArray(tasks) || tasks.length > this.config.localLimits.maxTasks) throw new JobInputError("tasks exceed the configured supervisor limit");
      const normalized = tasks.map((candidate) => {
        if (!object(candidate)) throw new JobInputError("invalid task");
        const execution = candidate.execution;
        if (!object(execution) || execution.mode !== "existing-session") throw new JobInputError("fresh execution is disabled; only registered existing sessions are enabled");
        const registered = project.registeredSessions.find((session) => accounts.includes(session.accountId));
        if (!registered) throw new JobInputError("no registered existing session is configured for the eligible accounts");
        const output = candidate.output;
        if (!object(output)) throw new JobInputError("invalid task output");
        if (output.kind === "text" && Number(output.maxBytes) > this.config.localLimits.maxOutputBytes) throw new JobInputError("text output exceeds the configured supervisor limit");
        if (output.kind === "json-records" && (!Array.isArray(output.requiredFields) || !output.requiredFields.length)) throw new JobInputError("the current durable scheduler requires JSON record fields");
        let supervisorOutput: Record<string, unknown>;
        if (output.kind === "coding-artifact") {
          supervisorOutput = { kind: "coding-artifact", repository: output.repositoryId, allowedPaths: output.allowedPaths, requirePullRequest: output.requirePullRequest ?? false };
        } else supervisorOutput = output;
        const scopes = Array.isArray(candidate.scopeKeys) ? candidate.scopeKeys as string[] : [];
        const effectiveScopes = scopes.length ? scopes : output.kind === "coding-artifact" && Array.isArray(output.allowedPaths)
          ? output.allowedPaths.map((path) => `path:${path}`)
          : [`path:token2oauth-output/${String(candidate.taskId)}`];
        const taskId = String(candidate.taskId);
        const digestInput = JSON.stringify({ taskId, dependsOn: candidate.dependsOn, scopeKeys: effectiveScopes, instructions: candidate.instructions, output: supervisorOutput });
        const inputSha256 = createHash("sha256").update(digestInput).digest("hex");
        return { taskId, dependsOn: candidate.dependsOn, scopeKeys: effectiveScopes,
          inputRef: `token2oauth-job:${String(args.jobId)}/${taskId}`, inputSha256, instructions: candidate.instructions,
          execution: { mode: "existing-session", sessionId: registered.sessionId, accountId: registered.accountId }, output: supervisorOutput };
      });
      const assignment = { schemaVersion: 1, assignmentId: args.jobId, idempotencyKey: args.idempotencyKey,
        projectId: project.projectId, eligibleAccountIds: accounts, tasks: normalized };
      if (Buffer.byteLength(JSON.stringify(assignment)) > this.config.localLimits.maxJobBytes) throw new JobInputError("job exceeds the configured supervisor byte limit");
      const result = await this.bridge.request("POST", "/v1/assignments", assignment);
      return boundedJson({ ...parseJson(result), dispatchEnabled: false, blockerCode: "worker_contract_mismatch" });
    }
    if (args.projectId !== project.projectId) throw new JobInputError("project is not authorized for this OAuth client");
    if (name === "job_status" || name === "job_results") {
      if (!safeId(args.jobId)) throw new JobInputError("jobId is invalid");
      const detail = await this.bridge.request("GET", `/admin/api/v1/assignments/${args.jobId}`);
      const row = parseJson(detail);
      if (row.projectId !== project.projectId) throw new JobInputError("job is not available");
      if (name === "job_results") return boundedJson({ jobId: args.jobId, resultsAvailable: false, reason: "durable bridge does not expose bounded result artifacts yet", tasks: row.tasks });
      return boundedJson({ ...row, dispatchEnabled: false, blockerCode: "worker_contract_mismatch" });
    }
    if (name === "job_workers") return boundedJson({ projectId: project.projectId, workers: [], dispatchEnabled: false,
      blockerCode: "worker_contract_mismatch", configuredAccounts: project.accountIds.map((accountId) => ({ accountId, capacity: "unknown", quota: "unknown" })) });
    if (name === "job_inbox") {
      const after = Number.isInteger(args.after) ? Number(args.after) : 0;
      const limit = Math.min(100, Number.isInteger(args.limit) ? Number(args.limit) : 50);
      const response = parseJson(await this.bridge.request("GET", `/admin/api/v1/events?after=${after}&limit=${limit}`));
      const events = Array.isArray(response.events) ? response.events.filter((event: unknown) => object(event) && event.projectId === project.projectId) : [];
      return boundedJson({ projectId: project.projectId, events, cursor: response.cursor, hasMore: response.hasMore });
    }
    // Python R21 exposes only global pause/emergency-stop controls; applying them
    // through a project-scoped MCP tool would affect unrelated projects.
    throw new JobInputError("project-scoped job control is unavailable in the current durable bridge");
  }

  async readAdmin(projectId: string): Promise<unknown> {
    const project = this.config.projects.find((item) => item.projectId === projectId);
    if (!project) throw new Error("project unavailable");
    return boundedJson(await this.bridge.request("GET", `/admin/api/v1/assignments?projectId=${encodeURIComponent(project.projectId)}&limit=50`));
  }
  async controlAdmin(input: { projectId: string; action: "pause_dispatch" | "resume_dispatch" | "emergency_stop"; expectedRevision: number }): Promise<unknown> {
    configuredProject(this.config, { projectId: input.projectId, clientId: this.config.projects.find((p) => p.projectId === input.projectId)?.clientIds[0] ?? "" });
    throw new Error("project-scoped supervisor controls are unavailable in the current durable bridge");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.bridge.close();
  }
}

export async function createSupervisorRuntime(options: SupervisorRuntimeOptions): Promise<SupervisorRuntime> {
  const config = await readSupervisorRuntimeConfig(options.configPath);
  const runtime = new SupervisorRuntime(config, options);
  await runtime.start();
  return runtime;
}
