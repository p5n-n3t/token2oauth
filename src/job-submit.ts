export const JOB_TOOLS = ["job_submit", "job_status", "job_workers", "job_results", "job_control", "job_inbox"] as const;
export type JobToolName = typeof JOB_TOOLS[number];
export type JobScope = "jobs:read" | "jobs:write";

export interface JobSubmission {
  schemaVersion: 1;
  jobId: string;
  idempotencyKey: string;
  projectId: string;
  eligibleAccountIds: string[];
  tasks: JobTaskInput[];
}

export interface JobTaskInput {
  taskId: string;
  dependsOn: string[];
  scopeKeys: string[];
  inputRef?: string;
  inputSha256?: string;
  instructions: string;
  execution: { mode: "fresh"; provider: "claude" | "codex" | "auto" | "pi" } | { mode: "existing-session" };
  output:
    | { kind: "json-records"; validator: "json-records"; ids: string[]; requiredFields: string[] }
    | { kind: "text"; maxBytes: number; format: string }
    | { kind: "coding-artifact"; repositoryId: string; allowedPaths: string[]; requirePullRequest?: boolean };
}

export class JobInputError extends Error {
  constructor(message: string) { super(message); this.name = "JobInputError"; }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const id = (v: unknown, label: string): string => {
  if (typeof v !== "string" || !ID.test(v)) throw new JobInputError(`${label} must be a safe identifier`);
  return v;
};
const str = (v: unknown, label: string, max: number): string => {
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new JobInputError(`${label} must be non-empty and at most ${max} characters`);
  return v;
};
const only = (v: Record<string, unknown>, keys: string[], label: string) => {
  if (Object.keys(v).some((key) => !keys.includes(key))) throw new JobInputError(`${label} contains an unsupported field`);
};

function scopeKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new JobInputError("scopeKeys contain an invalid scope");
  if (value.startsWith("record:") && /^record:[^\s:][^\s]*$/.test(value)) return value;
  if (value.startsWith("path:")) {
    const path = value.slice(5);
    if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new JobInputError("path scopes must be safe repository-relative paths");
    }
    return value;
  }
  throw new JobInputError("scopeKeys must use record: or path: scopes");
}

function parseTask(raw: unknown): JobTaskInput {
  if (!object(raw)) throw new JobInputError("each task must be an object");
  only(raw, ["taskId", "dependsOn", "scopeKeys", "inputRef", "inputSha256", "instructions", "execution", "output"], "task");
  const taskId = id(raw.taskId, "taskId");
  if (!Array.isArray(raw.dependsOn) || raw.dependsOn.length > 8) throw new JobInputError("dependsOn must be an array of at most 8 task IDs");
  const dependsOn = raw.dependsOn.map((v) => id(v, "dependency"));
  if (new Set(dependsOn).size !== dependsOn.length || dependsOn.includes(taskId)) throw new JobInputError("dependencies must be unique and cannot include the task itself");
  if (!Array.isArray(raw.scopeKeys) || raw.scopeKeys.length > 32) throw new JobInputError("scopeKeys must be an array of at most 32 scopes");
  const scopeKeys = raw.scopeKeys.map(scopeKey);
  if (new Set(scopeKeys).size !== scopeKeys.length) throw new JobInputError("scopeKeys must be unique");
  let inputRef: string | undefined;
  let inputSha256: string | undefined;
  if (raw.inputRef !== undefined) {
    inputRef = str(raw.inputRef, "inputRef", 2048);
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(inputRef)) throw new JobInputError("inputRef must be an opaque local reference, not a URL");
  }
  if (raw.inputSha256 !== undefined) {
    if (typeof raw.inputSha256 !== "string" || !HASH.test(raw.inputSha256) || !inputRef) throw new JobInputError("inputSha256 requires inputRef and 64 lowercase hexadecimal characters");
    inputSha256 = raw.inputSha256;
  }
  const instructions = str(raw.instructions, "instructions", 16_384);
  if (!object(raw.execution)) throw new JobInputError("execution must be an object");
  let execution: JobTaskInput["execution"];
  if (raw.execution.mode === "fresh") {
    only(raw.execution, ["mode", "provider"], "execution");
    if (!["claude", "codex", "auto", "pi"].includes(String(raw.execution.provider))) throw new JobInputError("fresh execution provider is unsupported");
    execution = { mode: "fresh", provider: raw.execution.provider as "claude" | "codex" | "auto" | "pi" };
  } else if (raw.execution.mode === "existing-session") {
    only(raw.execution, ["mode"], "execution");
    execution = { mode: "existing-session" };
  } else throw new JobInputError("execution.mode must be fresh or existing-session");

  if (!object(raw.output)) throw new JobInputError("output must be a tagged object");
  let output: JobTaskInput["output"];
  if (raw.output.kind === "json-records") {
    only(raw.output, ["kind", "validator", "ids", "requiredFields"], "output");
    if (raw.output.validator !== "json-records" || !Array.isArray(raw.output.ids) || !raw.output.ids.length || raw.output.ids.length > 500 || !Array.isArray(raw.output.requiredFields) || raw.output.requiredFields.length > 64) throw new JobInputError("json-records requires bounded ids and requiredFields");
    const ids = raw.output.ids.map((v) => str(v, "output id", 256));
    const requiredFields = raw.output.requiredFields.map((v) => str(v, "required field", 128));
    if (new Set(ids).size !== ids.length || new Set(requiredFields).size !== requiredFields.length) throw new JobInputError("JSON output ids and fields must be unique");
    output = { kind: "json-records", validator: "json-records", ids, requiredFields };
  } else if (raw.output.kind === "text") {
    only(raw.output, ["kind", "maxBytes", "format"], "output");
    if (!Number.isInteger(raw.output.maxBytes) || Number(raw.output.maxBytes) < 1 || Number(raw.output.maxBytes) > 32_768) throw new JobInputError("text maxBytes must be between 1 and 32768");
    output = { kind: "text", maxBytes: Number(raw.output.maxBytes), format: str(raw.output.format, "text format", 64) };
  } else if (raw.output.kind === "coding-artifact") {
    only(raw.output, ["kind", "repositoryId", "allowedPaths", "requirePullRequest"], "output");
    if (!Array.isArray(raw.output.allowedPaths) || !raw.output.allowedPaths.length || raw.output.allowedPaths.length > 100) throw new JobInputError("coding-artifact requires 1–100 allowed paths");
    const allowedPaths = raw.output.allowedPaths.map((p) => {
      if (typeof p !== "string") throw new JobInputError("allowedPaths must contain strings");
      return scopeKey(`path:${p}`).slice(5);
    });
    if (new Set(allowedPaths).size !== allowedPaths.length) throw new JobInputError("allowedPaths must be unique");
    if (typeof raw.output.requirePullRequest !== "undefined" && typeof raw.output.requirePullRequest !== "boolean") throw new JobInputError("requirePullRequest must be boolean");
    output = { kind: "coding-artifact", repositoryId: id(raw.output.repositoryId, "repositoryId"), allowedPaths, requirePullRequest: raw.output.requirePullRequest as boolean | undefined };
  } else throw new JobInputError("output.kind must be json-records, text, or coding-artifact");
  return { taskId, dependsOn, scopeKeys, inputRef, inputSha256, instructions, execution, output };
}

export function validateJobSubmission(value: unknown): JobSubmission {
  if (!object(value)) throw new JobInputError("job submission must be an object");
  only(value, ["schemaVersion", "jobId", "idempotencyKey", "projectId", "eligibleAccountIds", "tasks"], "job submission");
  if (value.schemaVersion !== 1) throw new JobInputError("schemaVersion must be 1");
  if (JSON.stringify(value).length > 1_048_576) throw new JobInputError("job submission exceeds 1 MiB");
  if (!Array.isArray(value.eligibleAccountIds) || value.eligibleAccountIds.length < 1 || value.eligibleAccountIds.length > 50) throw new JobInputError("eligibleAccountIds must contain 1–50 configured account IDs");
  const eligibleAccountIds = value.eligibleAccountIds.map((v) => id(v, "eligible account ID"));
  if (new Set(eligibleAccountIds).size !== eligibleAccountIds.length) throw new JobInputError("eligibleAccountIds must be unique");
  if (!Array.isArray(value.tasks) || value.tasks.length < 1 || value.tasks.length > 100) throw new JobInputError("tasks must contain 1–100 DAG nodes");
  const tasks = value.tasks.map(parseTask);
  const taskIds = new Set(tasks.map((task) => task.taskId));
  if (taskIds.size !== tasks.length) throw new JobInputError("taskIds must be unique");
  for (const task of tasks) if (task.dependsOn.some((dependency) => !taskIds.has(dependency))) throw new JobInputError("all dependencies must refer to tasks in this job");
  const visiting = new Set<string>(); const visited = new Set<string>();
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const visit = (taskId: string): void => {
    if (visiting.has(taskId)) throw new JobInputError("tasks must form an acyclic DAG");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId)!.dependsOn) visit(dependency);
    visiting.delete(taskId); visited.add(taskId);
  };
  for (const task of tasks) visit(task.taskId);
  return {
    schemaVersion: 1,
    jobId: id(value.jobId, "jobId"),
    idempotencyKey: id(value.idempotencyKey, "idempotencyKey"),
    projectId: id(value.projectId, "projectId"),
    eligibleAccountIds,
    tasks,
  };
}

const string = { type: "string" };
const tool = (name: JobToolName, description: string, properties: Record<string, unknown>, required: string[], additionalProperties = false) => ({
  name, description, inputSchema: { type: "object", properties, required, additionalProperties },
});
const jobKey = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$" };
export const JOB_TOOL_DEFINITIONS = [
  tool("job_submit", "Submit one explicitly authorized bounded task DAG for durable multi-account execution.", {
    schemaVersion: { type: "integer", const: 1 }, jobId: jobKey, idempotencyKey: jobKey, projectId: jobKey,
    eligibleAccountIds: { type: "array", minItems: 1, maxItems: 50, uniqueItems: true, items: jobKey },
    tasks: { type: "array", minItems: 1, maxItems: 100, items: { type: "object", additionalProperties: false,
      required: ["taskId", "dependsOn", "scopeKeys", "instructions", "execution", "output"],
      properties: {
        taskId: jobKey, dependsOn: { type: "array", maxItems: 8, items: jobKey }, scopeKeys: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", maxLength: 512 } },
        inputRef: { type: "string", minLength: 1, maxLength: 2048 }, inputSha256: { type: "string", pattern: "^[a-f0-9]{64}$" },
        instructions: { type: "string", minLength: 1, maxLength: 16384 },
        execution: { oneOf: [
          { type: "object", additionalProperties: false, required: ["mode", "provider"], properties: { mode: { const: "fresh" }, provider: { enum: ["claude", "codex", "auto", "pi"] } } },
          { type: "object", additionalProperties: false, required: ["mode"], properties: { mode: { const: "existing-session" } } },
        ] },
        output: { oneOf: [
          { type: "object", additionalProperties: false, required: ["kind", "validator", "ids", "requiredFields"], properties: { kind: { const: "json-records" }, validator: { const: "json-records" }, ids: { type: "array", minItems: 1, maxItems: 500, uniqueItems: true, items: { type: "string", maxLength: 256 } }, requiredFields: { type: "array", maxItems: 64, uniqueItems: true, items: { type: "string", maxLength: 128 } } } },
          { type: "object", additionalProperties: false, required: ["kind", "maxBytes", "format"], properties: { kind: { const: "text" }, maxBytes: { type: "integer", minimum: 1, maximum: 32768 }, format: { type: "string", minLength: 1, maxLength: 64 } } },
          { type: "object", additionalProperties: false, required: ["kind", "repositoryId", "allowedPaths"], properties: { kind: { const: "coding-artifact" }, repositoryId: jobKey, allowedPaths: { type: "array", minItems: 1, maxItems: 100, items: { type: "string", minLength: 1, maxLength: 512 } }, requirePullRequest: { type: "boolean" } } },
        ] },
      } } },
  }, ["schemaVersion", "jobId", "idempotencyKey", "projectId", "eligibleAccountIds", "tasks"]),
  tool("job_status", "Read one job's state for an authorized project.", { projectId: jobKey, jobId: jobKey }, ["projectId", "jobId"]),
  tool("job_workers", "Read bounded worker/account observations for an authorized project.", { projectId: jobKey }, ["projectId"]),
  tool("job_results", "Read bounded results for an authorized job/task.", { projectId: jobKey, jobId: jobKey, taskId: jobKey }, ["projectId", "jobId"]),
  tool("job_control", "Apply an allowlisted durable pause, stop, resume, or cancellation action.", { projectId: jobKey, action: { type: "string", enum: ["pause_dispatch", "resume_dispatch", "emergency_stop", "cancel_job"] }, jobId: jobKey }, ["projectId", "action"]),
  tool("job_inbox", "Read the caller's bounded durable incident inbox.", { projectId: jobKey, after: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, ["projectId"]),
] as const;

export function isJobToolName(value: unknown): value is JobToolName {
  return typeof value === "string" && (JOB_TOOLS as readonly string[]).includes(value);
}

export function requiredJobScope(name: JobToolName): JobScope {
  return name === "job_submit" || name === "job_control" ? "jobs:write" : "jobs:read";
}

export function validateJobToolArguments(name: JobToolName, value: unknown): unknown {
  if (name === "job_submit") return validateJobSubmission(value);
  if (!object(value)) throw new JobInputError("tool arguments must be an object");
  const allowed: Record<Exclude<JobToolName, "job_submit">, string[]> = {
    job_status: ["projectId", "jobId"], job_workers: ["projectId"], job_results: ["projectId", "jobId", "taskId"],
    job_control: ["projectId", "action", "jobId"], job_inbox: ["projectId", "after", "limit"],
  };
  only(value, allowed[name], name);
  id(value.projectId, "projectId");
  if (name === "job_status" || name === "job_results") id(value.jobId, "jobId");
  if (name === "job_results" && value.taskId !== undefined) id(value.taskId, "taskId");
  if (name === "job_control") {
    if (!["pause_dispatch", "resume_dispatch", "emergency_stop", "cancel_job"].includes(String(value.action))) throw new JobInputError("unsupported control action");
    if (value.action === "cancel_job") id(value.jobId, "jobId");
  }
  if (name === "job_inbox") {
    if (value.after !== undefined && (!Number.isSafeInteger(value.after) || Number(value.after) < 0)) throw new JobInputError("after must be a nonnegative integer");
    if (value.limit !== undefined && (!Number.isInteger(value.limit) || Number(value.limit) < 1 || Number(value.limit) > 100)) throw new JobInputError("limit must be between 1 and 100");
  }
  return value;
}
