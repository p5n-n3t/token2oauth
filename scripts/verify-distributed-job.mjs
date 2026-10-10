#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { StateStore } from "../dist/store.js";
import { buildApp } from "../dist/server.js";
import { createSupervisorRuntime, readSupervisorRuntimeConfig } from "../dist/supervisor-runtime.js";
import { pkceS256 } from "../dist/crypto.js";
import { PROVIDER_PROFILES } from "../dist/provider-capabilities.js";

const MAX_WAIT_MS = 5 * 60_000;
const TERMINAL = new Set(["complete", "completed", "failed", "cancelled", "ambiguous", "blocked"]);

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--isolated-auth") { out.isolated_auth = true; continue; }
    if (!["--config", "--state-dir", "--project-id", "--tasks", "--timeout-seconds"].includes(key) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error("Usage: verify-distributed-job.mjs --config PRIVATE_JSON --state-dir PRIVATE_STATE_DIR [--project-id ID] [--tasks 2|3] [--timeout-seconds 300] [--isolated-auth]");
    out[key.slice(2).replaceAll("-", "_")] = argv[++i];
  }
  if (!out.config || !out.state_dir) throw new Error("Both --config and --state-dir are required");
  out.tasks = Number(out.tasks || 2);
  out.timeout_seconds = Number(out.timeout_seconds || 300);
  if (![2, 3].includes(out.tasks) || !Number.isInteger(out.timeout_seconds) || out.timeout_seconds < 1 || out.timeout_seconds > 300) throw new Error("--tasks must be 2 or 3 and --timeout-seconds must be 1..300");
  return out;
}

const safeError = (error) => ({ name: error?.name || "Error", code: /^[A-Za-z0-9_]{1,80}$/.test(error?.code || "") ? error.code : undefined, message: String(error?.message || "operation failed").slice(0, 240) });
const jsonResponse = async (response) => {
  if (!response.ok) throw new Error(`local_gateway_http_${response.status}`);
  return response.json();
};

function ephemeralIssuerStore(store, base) {
  return new Proxy(store, { get(target, property) {
    if (property === "load") return async () => {
      const state = await target.load();
      return { ...state, config: { ...state.config, publicBaseUrl: typeof base === "function" ? base() : base } };
    };
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function listen(server) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolveListen(server.address()));
  });
}
function closeServer(server) {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

async function promptAdminPassword() {
  if (!stdin.isTTY) throw new Error("Run from a terminal so the gateway admin password can be entered without echo");
  stdout.write("Gateway admin password (input hidden): ");
  let echoDisabled = false;
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    echoDisabled = true;
    const rl = createInterface({ input: stdin, output: stdout, terminal: false });
    const value = await rl.question("");
    rl.close();
    stdout.write("\n");
    return value.trim();
  } finally {
    if (echoDisabled) {
      try { execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); } catch {}
    }
  }
}

async function issueScopedToken(base, password, remember) {
  const redirectUri = `${base}/local-oauth-callback`;
  const registration = await jsonResponse(await fetch(`${base}/oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: `t2o-r34-${Date.now()}`, redirect_uris: [redirectUri] }),
  }));
  const clientId = registration.client_id;
  if (typeof clientId !== "string") throw new Error("local_oauth_client_registration_failed");
  remember({ clientId });
  const verifier = randomBytes(48).toString("base64url");
  const stateValue = randomBytes(24).toString("base64url");
  const form = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", code_challenge: pkceS256(verifier), code_challenge_method: "S256", state: stateValue, resource: `${base}/mcp`, scope: "mcp jobs:read jobs:write", admin_password: password });
  const consent = await fetch(`${base}/oauth/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  const location = consent.headers.get("location");
  if (consent.status < 300 || consent.status >= 400 || !location) throw new Error(`local_oauth_consent_failed_${consent.status}`);
  const callback = new URL(location, base);
  if (callback.origin !== base || callback.searchParams.get("state") !== stateValue) throw new Error("local_oauth_callback_mismatch");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("local_oauth_code_missing");
  const token = await jsonResponse(await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", client_id: clientId, redirect_uri: redirectUri, code, code_verifier: verifier, resource: `${base}/mcp` }) }));
  remember({ clientId, refreshToken: token.refresh_token });
  if (typeof token.access_token !== "string" || token.scope !== "mcp jobs:read jobs:write") throw new Error("local_oauth_scope_mismatch");
  return { clientId, accessToken: token.access_token, refreshToken: token.refresh_token };
}

async function mcp(base, accessToken, id, name, toolArguments) {
  const response = await fetch(`${base}/mcp`, { method: "POST", signal: AbortSignal.timeout(10_000), headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: toolArguments } }) });
  const packet = await jsonResponse(response);
  const result = packet?.result;
  if (!result || result.isError) throw new Error(`mcp_tool_${name}_rejected`);
  const text = Array.isArray(result.content) ? result.content.find((part) => part?.type === "text")?.text : undefined;
  if (typeof text !== "string") return result.structuredContent ?? result;
  try { return JSON.parse(text); } catch { throw new Error(`mcp_tool_${name}_returned_unstructured_result`); }
}

async function toolsList(base, accessToken) {
  const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" };
  const initialized = await jsonResponse(await fetch(`${base}/mcp`, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: {
      protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "token2oauth-verifier", version: "1" },
    } }) }));
  if (initialized.result?.protocolVersion !== "2025-06-18" || !initialized.result?.capabilities?.tools) throw new Error("local_mcp_initialization_failed");
  const notification = await fetch(`${base}/mcp`, { method: "POST", headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  if (notification.status !== 204) throw new Error("local_mcp_initialized_notification_failed");
  const response = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
  const packet = await jsonResponse(response);
  if (!Array.isArray(packet?.result?.tools)) throw new Error("mcp_tools_list_unavailable");
  return packet.result.tools;
}

function toolSupportsExpectedMarker(tools) {
  const job = tools.find((item) => item?.name === "job_submit");
  return job?.inputSchema?.properties?.tasks?.items?.properties?.output?.properties?.expectedMarker !== undefined;
}
function parseTaskRows(value) {
  return Array.isArray(value?.tasks) ? value.tasks.filter((row) => row && typeof row.taskId === "string") : [];
}
function timestamp(row, keys) {
  for (const key of keys) {
    const value = row?.[key];
    const parsed = typeof value === "number" ? (value < 100_000_000_000 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}
function terminal(value) {
  if (TERMINAL.has(String(value?.state || "").toLowerCase())) return true;
  const rows = parseTaskRows(value);
  return rows.length > 0 && rows.every((row) => TERMINAL.has(String(row.state || "").toLowerCase()));
}
function nativeLightSprintUrl(value) {
  if (typeof value !== "string") return false;
  try { const actual = new URL(value); const expected = new URL(PROVIDER_PROFILES.lightsprint.defaultServerUrl); return actual.protocol === "https:" && actual.hostname === expected.hostname && actual.port === "" && actual.pathname === "/mcp" && !actual.username && !actual.password && !actual.search && !actual.hash && actual.href === expected.href; } catch { return false; }
}
function evidenceOverlap(samples, rows) {
  const simultaneous = samples.filter((sample) => sample.runningTaskIds.length > 1);
  const intervals = rows.map((row) => ({ taskId: row.taskId, state: row.state || "unknown", startedAt: timestamp(row, ["startedAt", "started_at", "dispatchAt", "dispatch_at"]), finishedAt: timestamp(row, ["finishedAt", "finished_at", "completedAt", "completed_at"]) }));
  return { simultaneousRunningSamples: simultaneous, taskIntervals: intervals, overlapObserved: simultaneous.length > 0 };
}

async function main() {
  const options = args(process.argv.slice(2));
  process.env.TOKEN2OAUTH_CONFIG_DIR = resolve(options.state_dir);
  const store = new StateStore();
  const stateFile = await lstat(store.statePath).catch(() => null);
  const keyFile = await lstat(store.keyPath).catch(() => null);
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!stateFile?.isFile() || stateFile.isSymbolicLink() || !keyFile?.isFile() || keyFile.isSymbolicLink() || (uid !== undefined && (stateFile.uid !== uid || keyFile.uid !== uid)) || (stateFile.mode & 0o077) !== 0 || (keyFile.mode & 0o077) !== 0) throw new Error("--state-dir must point to an existing owner-only StateStore with its master key; the harness will not initialize a new store");
  await store.init();
  const runtimeConfig = await readSupervisorRuntimeConfig(resolve(options.config));
  const project = options.project_id ? runtimeConfig.projects.find((row) => row.projectId === options.project_id) : runtimeConfig.projects[0];
  if (!project) throw new Error("configured_project_not_found");
  const state = await store.load();
  const accounts = project.accountIds.map((id) => state.accounts.find((row) => row.id === id)).filter(Boolean);
  if (accounts.length < options.tasks || accounts.some((row) => row.enabled !== true || !(row.provider === "lightsprint" || (row.provider === "generic-bearer-mcp" && nativeLightSprintUrl(state.config.upstreamUrl))))) throw new Error("selected project lacks enough enabled LightSprint-eligible accounts in StateStore");
  const sessionAccounts = new Set(project.registeredSessions.map((row) => row.accountId));
  if (accounts.filter((row) => sessionAccounts.has(row.id)).length < options.tasks) throw new Error("selected project lacks enough registered existing sessions");

  let runtime;
  let gateway;
  let oauth;
  const oauthCleanup = {};
  let isolatedRuntimeDir;
  let isolatedAuthDir;
  let authStore = store;
  let base;
  let submissionAttempted = false;
  let evidence = { assignmentId: null, projectId: project.projectId, submittedAt: null, submission: "not_attempted", state: "blocked", tasks: [], runningIntervals: { simultaneousRunningSamples: [], taskIntervals: [], overlapObserved: false }, blockers: [] };
  evidence.eligibleAccountIds = accounts.slice(0, options.tasks).map((row) => row.id);
  try {
    isolatedRuntimeDir = await mkdtemp(resolve(tmpdir(), "t2o-r40-runtime-"));
    if (options.isolated_auth) {
      isolatedAuthDir = await mkdtemp(resolve(tmpdir(), "t2o-r40-auth-"));
      process.env.TOKEN2OAUTH_CONFIG_DIR = isolatedAuthDir;
      authStore = new StateStore();
      const temporaryPassword = randomBytes(48).toString("base64url");
      await authStore.init({ adminPassword: temporaryPassword });
      const lazyBackend = { callTool: (...args) => runtime ? runtime.callTool(...args) : Promise.reject(new Error("isolated runtime is not ready")) };
      const built = await buildApp(ephemeralIssuerStore(authStore, () => base || "http://127.0.0.1"), { supervisorBackend: lazyBackend });
      gateway = createServer(built.app);
      const address = await listen(gateway);
      base = `http://127.0.0.1:${address.port}`;
      oauth = await issueScopedToken(base, temporaryPassword, (values) => Object.assign(oauthCleanup, values));
      const privateConfig = JSON.parse(await readFile(resolve(options.config), "utf8"));
      const selected = privateConfig.projects?.find((row) => row.projectId === project.projectId);
      if (!selected) throw new Error("private_config_project_disappeared");
      selected.clientIds = [oauth.clientId];
      const runtimeConfigCopy = resolve(isolatedRuntimeDir, "runtime.json");
      await writeFile(runtimeConfigCopy, `${JSON.stringify(privateConfig, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await mkdir(resolve(isolatedRuntimeDir, "bridge"), { mode: 0o700 });
      runtime = await createSupervisorRuntime({ configPath: runtimeConfigCopy, configDir: resolve(isolatedRuntimeDir, "bridge"), supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)), store });
    } else {
      runtime = await createSupervisorRuntime({ configPath: resolve(options.config), configDir: isolatedRuntimeDir, supervisorCwd: fileURLToPath(new URL("../supervisor/", import.meta.url)), store });
      const built = await buildApp(ephemeralIssuerStore(store, () => base || "http://127.0.0.1"), { supervisorBackend: runtime });
      gateway = createServer(built.app);
      const address = await listen(gateway);
      base = `http://127.0.0.1:${address.port}`;
      const password = await promptAdminPassword();
      oauth = await issueScopedToken(base, password, (values) => Object.assign(oauthCleanup, values));
    }
    const tools = await toolsList(base, oauth.accessToken);
    if (!toolSupportsExpectedMarker(tools)) {
      evidence.blockers.push("job_submit schema does not accept output.expectedMarker; completion cannot be safely validated by this checkout");
      return;
    }
    const workers = await mcp(base, oauth.accessToken, 2, "job_workers", { projectId: project.projectId });
    if (workers.dispatchEnabled !== true || workers.blockerCode) {
      evidence.blockers.push(`dispatch unavailable (${String(workers.blockerCode || "dispatchEnabled_false")})`);
      return;
    }

    const jobId = `r34-${Date.now()}-${randomBytes(5).toString("hex")}`;
    evidence.assignmentId = jobId;
    const tasks = Array.from({ length: options.tasks }, (_, index) => {
      const taskId = `task-${index + 1}`;
      const expectedMarker = `${jobId}-${taskId}-OK`;
      return { taskId, dependsOn: [], scopeKeys: [`path:token2oauth-output/${jobId}/${taskId}`], instructions: `Return exactly this marker and nothing else: ${expectedMarker}. Do not use tools, read or write files, access external services, or continue any prior work.`, execution: { mode: "existing-session" }, output: { kind: "text", maxBytes: 256, format: "plain text", expectedMarker } };
    });
    evidence.tasks = tasks.map((task) => ({ taskId: task.taskId, expectedMarkerMatched: false, state: "not_started" }));
    evidence.submittedAt = new Date().toISOString();
    submissionAttempted = true;
    let stopPolling = false;
    try {
      const submitted = await mcp(base, oauth.accessToken, 3, "job_submit", { schemaVersion: 1, jobId, idempotencyKey: jobId, projectId: project.projectId, eligibleAccountIds: accounts.slice(0, options.tasks).map((row) => row.id), tasks });
      evidence.submission = "accepted";
      evidence.state = submitted.state || "unknown";
      if (submitted.dispatchEnabled === false || submitted.blockerCode) {
        evidence.blockers.push(`submission accepted but dispatch is blocked (${String(submitted.blockerCode || "dispatchEnabled_false")})`);
        stopPolling = true;
      }
    } catch (error) {
      evidence.submission = "ambiguous";
      evidence.blockers.push("job_submit response was not confirmed; it will not be retried");
      evidence.submitError = safeError(error);
    }

    const deadline = Date.parse(evidence.submittedAt) + Math.min(options.timeout_seconds * 1000, MAX_WAIT_MS);
    const samples = [];
    let last = null;
    while (!stopPolling && Date.now() < deadline) {
      try {
        last = await mcp(base, oauth.accessToken, 4, "job_status", { projectId: project.projectId, jobId });
        const rows = parseTaskRows(last);
        const runningTaskIds = rows.filter((row) => String(row.state).toLowerCase() === "running").map((row) => row.taskId);
        samples.push({ observedAt: new Date().toISOString(), runningTaskIds });
        if (terminal(last)) break;
      } catch (error) {
        if (submissionAttempted && evidence.submission === "ambiguous") evidence.blockers.push("read-only status lookup did not confirm the ambiguous submission");
        else evidence.blockers.push(`status read failed (${safeError(error).name})`);
        break;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2000));
    }
    if (last) {
      const rows = parseTaskRows(last);
      const tasksComplete = rows.length > 0 && rows.every((row) => ["complete", "completed"].includes(String(row.state || "").toLowerCase()));
      const jobComplete = ["complete", "completed"].includes(String(last.state || "").toLowerCase()) || tasksComplete;
      evidence.state = !terminal(last) && Date.now() >= deadline ? "timeout" : jobComplete ? "complete" : last.state || (terminal(last) ? "terminal" : "unknown");
      evidence.tasks = rows.map((row) => ({ taskId: row.taskId, state: row.state || "unknown", selectedAccountId: row.selectedAccountId || null, startedAt: timestamp(row, ["startedAt", "started_at", "dispatchAt", "dispatch_at"]), finishedAt: timestamp(row, ["finishedAt", "finished_at", "completedAt", "completed_at"]), expectedMarkerMatched: false }));
      evidence.distinctSelectedAccounts = new Set(evidence.tasks.map((task) => task.selectedAccountId).filter(Boolean)).size;
      if (evidence.tasks.length > 1 && evidence.distinctSelectedAccounts < 2) evidence.blockers.push("status did not show work assigned to multiple accounts; distributed execution is unproven");
      evidence.runningIntervals = evidenceOverlap(samples, rows);
      if (terminal(last) && jobComplete) {
        const result = await mcp(base, oauth.accessToken, 5, "job_results", { projectId: project.projectId, jobId });
        const resultRows = Array.isArray(result.results) ? result.results : parseTaskRows(result);
        if (result.resultsAvailable !== true && !Array.isArray(result.results)) evidence.blockers.push("job_results did not expose the documented bounded results DTO; completion markers remain unverified");
        if (Array.isArray(result.results) && evidence.tasks.some((task) => !result.results.some((item) => (item.task_id || item.taskId) === task.taskId && typeof item.text === "string"))) evidence.blockers.push("job_results omitted one or more bounded task text rows; completion markers remain unverified");
        for (const task of evidence.tasks) {
          const row = resultRows.find((item) => (item.taskId || item.task_id) === task.taskId);
          const text = typeof row?.text === "string" ? row.text : typeof row?.result === "string" ? row.result : typeof row?.assistantText === "string" ? row.assistantText : "";
          task.expectedMarkerMatched = text === `${jobId}-${task.taskId}-OK`;
          task.resultAt = timestamp(row, ["assistant_at", "assistantAt", "at"]);
        }
      }
    } else if (submissionAttempted) evidence.state = "status_unconfirmed";
  } finally {
    if (oauth || oauthCleanup.clientId) {
      const refreshToken = oauth?.refreshToken || oauthCleanup.refreshToken;
      const tokenHash = refreshToken ? createHash("sha256").update(refreshToken).digest("base64url") : null;
      await authStore.update((current) => {
        current.oauthClients = current.oauthClients.filter((client) => client.clientId !== (oauth?.clientId || oauthCleanup.clientId));
        if (tokenHash) current.refreshTokens = current.refreshTokens.filter((record) => record.tokenHash !== tokenHash);
      }).catch(() => undefined);
      if (oauth) { oauth.accessToken = ""; oauth.refreshToken = ""; }
    }
    if (gateway?.listening) await closeServer(gateway);
    if (runtime) await runtime.close().catch(() => undefined);
    const retainRuntime = submissionAttempted && (evidence.state !== "complete" || evidence.tasks.some((task) => !task.expectedMarkerMatched));
    if (isolatedRuntimeDir && !retainRuntime) await rm(isolatedRuntimeDir, { recursive: true, force: true }).catch(() => undefined);
    if (isolatedAuthDir) await rm(isolatedAuthDir, { recursive: true, force: true }).catch(() => undefined);
    process.stdout.write(`${JSON.stringify({ ...evidence, observedAt: new Date().toISOString(), retainedRuntimeDir: retainRuntime ? isolatedRuntimeDir : null, cleanup: "local gateway and bridge child closed; unfinished job state retained when necessary; temporary OAuth records removed; no remote session control sent" }, null, 2)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ state: "harness_error", error: safeError(error) })}\n`);
  process.exitCode = 1;
});
