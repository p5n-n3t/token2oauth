import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";
import { isAllowedSupervisorRoute } from "../dist/supervisor-bridge.js";

const config = {
  version: 1,
  projects: [{ projectId: "project-a", clientIds: ["client-a"], accountIds: ["acct-a", "acct-b"], registeredSessions: [
    { sessionId: "session-a", accountId: "acct-a", model: "gpt-6-luna" },
  ] }],
  maxWorkers: 2,
  allowUnknownQuota: true,
  localLimits: { maxTasks: 100, maxJobBytes: 1048576, maxOutputBytes: 32768 },
};
const store = { async load() { return { accounts: ["acct-a", "acct-b"].map((id) => ({ id, provider: "lightsprint", enabled: true })) }; } };
const caller = { clientId: "client-a", projectId: "project-a" };
const submission = {
  schemaVersion: 1, jobId: "job-one", idempotencyKey: "idem-one", projectId: "project-a",
  eligibleAccountIds: ["acct-a", "acct-b"],
  tasks: [{ taskId: "task-one", dependsOn: [], scopeKeys: ["path:src/example.ts"], instructions: "Review this bounded source change.",
    execution: { mode: "existing-session" }, output: { kind: "coding-artifact", repositoryId: "repo-a", allowedPaths: ["src/example.ts"] } }],
};

test("private runtime composes the real Python Unix bridge and keeps jobs across restart", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-runtime-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "runtime.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await readSupervisorRuntimeConfig(configPath)).projects[0].projectId, "project-a");
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/assignments"), true);
  assert.equal(isAllowedSupervisorRoute("POST", "/v1/accounts"), false);
  assert.equal(isAllowedSupervisorRoute("GET", "/admin/api/v1/assignments/job-one/../../other"), false);

  const options = { configPath, configDir: dir, supervisorCwd: join(process.cwd(), "supervisor"), store };
  const runtime = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await runtime.start();
  t.after(() => runtime.close());
  const receipt = await runtime.callTool("job_submit", submission, caller);
  assert.equal(receipt.assignmentId, "job-one");
  assert.equal(receipt.state, "queued");
  assert.deepEqual(await runtime.callTool("job_submit", submission, caller), receipt);
  const status = await runtime.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(status.tasks[0].taskId, "task-one");
  await assert.rejects(runtime.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, { clientId: "client-b", projectId: "project-a" }));
  await assert.rejects(runtime.callTool("job_submit", { ...submission, eligibleAccountIds: ["acct-a"] }, caller), /at least two/);
  await runtime.close();

  const restarted = new SupervisorRuntime(await readSupervisorRuntimeConfig(configPath), options);
  await restarted.start();
  t.after(() => restarted.close());
  const persisted = await restarted.callTool("job_status", { projectId: "project-a", jobId: "job-one" }, caller);
  assert.equal(persisted.assignmentId, "job-one");
  assert.equal(persisted.tasks[0].state, "queued");
});

test("runtime config rejects permissive fields and non-private files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "t2o-config-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "runtime.json");
  await writeFile(path, JSON.stringify({ ...config, executable: "/bin/sh" }), { mode: 0o600 });
  await assert.rejects(readSupervisorRuntimeConfig(path));
  await writeFile(path, JSON.stringify(config), { mode: 0o644 });
  await chmod(path, 0o644);
  await assert.rejects(readSupervisorRuntimeConfig(path));
});
