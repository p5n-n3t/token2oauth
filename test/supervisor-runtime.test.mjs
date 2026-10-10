import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";
import { isAllowedSupervisorRoute } from "../dist/supervisor-bridge.js";

const config = {
  version: 1,
  projects: [
    { projectId: "project-a", clientIds: ["client-a", "client-b"], accountIds: ["acct-a", "acct-b"], registeredSessions: [
    { sessionId: "session-a", accountId: "acct-a", model: "gpt-6-luna", workspaceId: "workspace-a" },
    { sessionId: "session-b", accountId: "acct-b", model: "gpt-6-luna", workspaceId: "workspace-b" },
    ] },
    { projectId: "project-b", clientIds: ["client-a"], accountIds: ["acct-c"], registeredSessions: [
      { sessionId: "session-c", accountId: "acct-c", model: "gpt-6-luna", workspaceId: "workspace-c" },
    ] },
  ],
  maxWorkers: 2,
  allowUnknownQuota: true,
  localLimits: { maxTasks: 100, maxJobBytes: 1048576, maxOutputBytes: 32768 },
};
const currentState = {
  config: { upstreamUrl: "https://app.lightsprint.ai/mcp" },
  accounts: ["acct-a", "acct-b", "acct-c"].map((id) => ({ id, provider: "lightsprint", enabled: true, stats: { state: "healthy" } })),
};
const store = { async load() { return currentState; } };
const caller = { clientId: "client-a", projectId: "project-a" };
const submission = {
  schemaVersion: 1, jobId: "job-one", idempotencyKey: "idem-one", projectId: "project-a",
  eligibleAccountIds: ["acct-a", "acct-b"],
  tasks: ["task-one", "task-two"].map((taskId) => ({ taskId, dependsOn: [], scopeKeys: [`path:src/${taskId}.txt`], instructions: "Write a short bounded result.",
    execution: { mode: "existing-session" }, output: { kind: "text", maxBytes: 2048, format: "plain text", expectedMarker: `DONE-${taskId}` } })),
};

function fakeAdapter(accountId) {
  let marker = "";
  return {
    accountId,
    async sessionStatus() { return { classification: "accepted", accountId, value: { status: "idle", isOwner: true, canSendMessage: true, registeredModel: "gpt-6-luna" } }; },
    async sendMessage(_sessionId, message) {
      marker = message.match(/exact completion marker on its own line: (.+)$/)?.[1] ?? "";
      return { classification: "accepted", accountId, value: {} };
    },
    async sessionTranscript() { return { classification: "accepted", accountId, value: {
      latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: `Result ${marker}`, timestamp: new Date().toISOString(), complete: true }],
    } }; },
    async stopSession() { return { classification: "accepted", accountId, value: {} }; },
  };
}
async function waitComplete(runtime) {
  let last;
  for (let i = 0; i < 100; i++) {
    const value = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
    last = value;
    if (value.tasks?.length && value.tasks.every((task) => task.state === "complete")) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job did not complete before test deadline: ${JSON.stringify(last)}`);
}

test("real Python IPC registers two accounts, completes pinned tasks, isolates callers, and resumes durable results", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await readSupervisorRuntimeConfig(configPath)).projects[0].projectId, "project-a");
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts"), true);
  assert.equal(isAllowedSupervisorRoute("GET", "/v1/assignments/job-one/results"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments/job-one/cancel"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts/other"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/assignments/job-one/../../other"), false);

  const adapters = new Map();
  const options = { configPath, configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"), store,
    adapterFactory: (accountId) => { if (!adapters.has(accountId)) adapters.set(accountId, fakeAdapter(accountId)); return adapters.get(accountId); },
    workerOptions: { pollIntervalMs: 20, adapterTimeoutMs: 1000 } };
  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await runtime.start();
  t.after(() => runtime.close());
  const receipt = await runtime.callTool("job_submit", submission, caller);
  assert.equal(receipt.assignmentId, "job-one");
  assert.equal(receipt.state, "queued");
  assert.deepEqual(await runtime.callTool("job_submit", submission, caller), receipt);
  const completed = await waitComplete(runtime);
  assert.equal(completed.state, "complete");
  assert.deepEqual(completed.tasks.map((task) => task.selectedAccountId), ["acct-a", "acct-b"]);
  assert.deepEqual(completed.tasks.map((task) => task.sessionId), ["session-a", "session-b"]);
  const results = await runtime.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.deepEqual(results.results.map((result) => result.taskId).sort(), ["task-one", "task-two"]);
  assert.ok(results.results.every((result) => result.text.includes("DONE-task-")));
  await assert.rejects(runtime.callTool("job_results", { projectId: "project-b", jobId: "job-one" }, { ...caller, projectId: "project-b" }), /job is not available/);
  const snapshot = await runtime.readAdmin("project-a");
  assert.equal(snapshot.state, "ready");
  assert.equal(snapshot.providers[0].accounts.length, 2);
  assert.equal(snapshot.jobs.find((job) => job.id === "job-one").status, "complete");
  assert.equal(snapshot.tasks.filter((task) => task.status === "complete").length, 2);
  assert.ok(snapshot.events.some((event) => event.source === "supervisor"));
  assert.equal("capacity" in snapshot.providers[0].accounts[0], false);
  assert.equal("quota" in snapshot.providers[0].accounts[0], false);
  await assert.rejects(runtime.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, { clientId: "client-b", projectId: "project-a" }));
  const workers = await runtime.callTool("job_workers", { projectId: "project-a" }, caller);
  assert.equal(workers.workers.length, 2);
  currentState.accounts.find((account) => account.id === "acct-b").stats.state = "auth-failed";
  const narrowed = await runtime.callTool("job_submit", { ...submission, jobId: "job-two", idempotencyKey: "idem-two", tasks: [submission.tasks[0]] }, caller);
  assert.equal(narrowed.assignmentId, "job-two");
  const narrowedStatus = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-two" }, caller);
  assert.deepEqual(narrowedStatus.eligibleAccountIds, ["acct-a"]);
  await runtime.close();

  const restarted = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await restarted.start();
  t.after(() => restarted.close());
  const persisted = await restarted.callTool("job_results", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(persisted.results.length, 2);
  const resumed = await restarted.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(resumed.state, "complete");
  assert.ok(resumed.tasks.every((task) => task.state === "complete"));
});

test("runtime config rejects permissive fields, missing workspace bindings, and non-private files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.json");
  await writeFile(path, JSON.stringify({ ...config, executable: "/bin/sh" }), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path));
  const missingWorkspace = structuredClone(config);
  delete missingWorkspace.projects[0].registeredSessions[0].workspaceId;
  await writeFile(path, JSON.stringify(missingWorkspace), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path));
  const duplicateSession = structuredClone(config);
  duplicateSession.projects[1].registeredSessions[0].sessionId = "session-a";
  await writeFile(path, JSON.stringify(duplicateSession), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path), /only one project/);
  await writeFile(path, JSON.stringify(config), { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(readSupervisorRuntimeConfig(path));
});
