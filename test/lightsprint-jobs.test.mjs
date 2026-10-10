import test from "node:test";
import assert from "node:assert/strict";
import { LightSprintJobsAdapter } from "../dist/providers/lightsprint-jobs.js";

const ACCOUNT_ID = "acct_owner_7";
const TASK_ID = "task_123";
const SESSION_ID = "session_456";
const PINNED_TOKEN = "mock-secret-never-log";

function store() {
  return {
    async load() {
      return { accounts: [{ id: ACCOUNT_ID, provider: "lightsprint", enabled: true }] };
    },
    async revealToken(account) {
      assert.equal(account.id, ACCOUNT_ID);
      return PINNED_TOKEN;
    },
  };
}
function clientFactory(handler) {
  return () => ({ request: handler });
}
function ok(value) {
  return { structuredContent: value, isError: false };
}

test("native MCP transport stays account-pinned and uses initialize/session/tool-call framing", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    const request = JSON.parse(init.body);
    seen.push({ url: String(url), request, auth: new Headers(init.headers).get("authorization"), session: new Headers(init.headers).get("mcp-session-id") });
    if (request.method === "initialize") {
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-06-18" } }), {
        status: 200,
        headers: { "content-type": "application/json", "mcp-session-id": "owned-session" },
      });
    }
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: ok([{ id: TASK_ID }]) }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, { fetch });
  const result = await adapter.listTaskAgents(TASK_ID);
  assert.equal(result.classification, "accepted");
  assert.equal(result.accountId, ACCOUNT_ID);
  assert.deepEqual(result.value, [{ id: TASK_ID }]);
  assert.equal(seen[0].request.method, "initialize");
  assert.equal(seen[0].request.id, 1);
  assert.equal(seen[1].request.method, "notifications/initialized");
  assert.equal(seen[2].request.method, "tools/call");
  assert.equal(seen[2].request.id, 2);
  assert.equal(seen[2].request.params.name, "lightsprint_api");
  assert.equal(seen[2].request.params.arguments.path, `/api/tasks/${TASK_ID}/lightsprint-agents`);
  assert.ok(seen.every((request) => request.url === "https://app.lightsprint.ai/mcp"));
  assert.ok(seen.every((request) => request.auth === `Bearer ${PINNED_TOKEN}`));
  assert.equal(seen[2].session, "owned-session");
});

test("chat sends only the requested current message and clientMessageId", async () => {
  let call;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      call = params;
      return ok({ accepted: true });
    }),
  });
  const result = await adapter.sendMessage(SESSION_ID, "Please review the current patch.", "msg-20261010-1");
  assert.equal(result.classification, "accepted");
  assert.deepEqual(call, {
    name: "lightsprint_api",
    arguments: {
      method: "POST",
      path: `/api/agent-sessions/${SESSION_ID}/chat`,
      body: { content: "Please review the current patch.", clientMessageId: "msg-20261010-1" },
    },
  });
});

test("lost launch response is ambiguous and is never replayed", async () => {
  let launchCalls = 0;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      const { method, path } = params.arguments;
      if (method === "PATCH") return ok({ id: TASK_ID, description: "Reviewed exact instructions." });
      if (method === "GET") return ok({ id: TASK_ID, description: "Reviewed exact instructions." });
      if (path.endsWith("/lightsprint-agents/claude")) {
        launchCalls += 1;
        throw new Error("response lost after request");
      }
      throw new Error("unexpected request");
    }),
  });
  assert.equal((await adapter.patchTaskInstructions(TASK_ID, "Reviewed exact instructions.")).classification, "accepted");
  const result = await adapter.launchTask(TASK_ID, "claude");
  assert.equal(result.classification, "ambiguous");
  assert.equal(result.reason, "transport_ambiguous");
  assert.equal(launchCalls, 1);
});

test("HTTP 200 tool errors carrying status 402 classify as quota, without echoing the body", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async () => ({ isError: true, structuredContent: { status: 402, error: "private upstream message" } })),
  });
  const result = await adapter.readTask(TASK_ID);
  assert.equal(result.classification, "rejected");
  assert.equal(result.reason, "quota");
  assert.equal(result.httpStatus, 402);
  assert.equal(JSON.stringify(result).includes("private upstream message"), false);
});

test("instruction mismatch after readback prevents launch", async () => {
  let launchCalls = 0;
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      const { method, path } = params.arguments;
      if (method === "PATCH") return ok({ id: TASK_ID, description: "Intended instructions." });
      if (method === "GET") return ok({ id: TASK_ID, description: "Server kept stale instructions." });
      if (path.includes("/lightsprint-agents/")) launchCalls += 1;
      return ok({});
    }),
  });
  const patched = await adapter.patchTaskInstructions(TASK_ID, "Intended instructions.");
  assert.equal(patched.classification, "rejected");
  assert.equal(patched.reason, "instructions_mismatch");
  const launched = await adapter.launchTask(TASK_ID, "claude");
  assert.equal(launched.classification, "rejected");
  assert.equal(launchCalls, 0);
});

test("input IDs and arbitrary provider URLs are not accepted", async () => {
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: () => ({ request: async () => ok({}) }),
  });
  assert.throws(() => adapter.readTask("../other"), /taskId is invalid/);
  await assert.rejects(async () => {
    const { createLightSprintMcpClient } = await import("../dist/providers/lightsprint-jobs.js");
    createLightSprintMcpClient({ endpoint: new URL("https://attacker.example/mcp"), token: PINNED_TOKEN, fetch: globalThis.fetch, timeoutMs: 1_000 });
  }, /unsafe LightSprint MCP endpoint/);
});

test("task/session operations use documented account-scoped routes and bound transcript output", async () => {
  const calls = [];
  const adapter = new LightSprintJobsAdapter(store(), ACCOUNT_ID, {
    clientFactory: clientFactory(async (_method, params) => {
      calls.push(params.arguments);
      if (params.arguments.path.endsWith("/transcript")) return ok({ transcript: "x".repeat(260_000) });
      return ok({ id: TASK_ID });
    }),
  });
  assert.equal((await adapter.createTask("Bounded title", "stack_1")).classification, "accepted");
  await adapter.readTask(TASK_ID);
  await adapter.listTaskAgents(TASK_ID);
  await adapter.sessionStatus(SESSION_ID);
  const transcript = await adapter.sessionTranscript(SESSION_ID);
  assert.equal(transcript.value.truncated, true);
  assert.ok(transcript.value.preview.length <= 250_000);
  await adapter.cancelTurn(SESSION_ID);
  await adapter.stopSession(SESSION_ID);
  assert.deepEqual(calls.map(({ method, path }) => [method, path]), [
    ["POST", "/api/tasks"],
    ["GET", `/api/tasks/${TASK_ID}`],
    ["GET", `/api/tasks/${TASK_ID}/lightsprint-agents`],
    ["GET", `/api/agent-sessions/${SESSION_ID}/status`],
    ["GET", `/api/agent-sessions/${SESSION_ID}/transcript`],
    ["POST", `/api/agent-sessions/${SESSION_ID}/cancel`],
    ["POST", `/api/agent-sessions/${SESSION_ID}/stop`],
  ]);
  assert.deepEqual(calls[0].body, { title: "Bounded title", scope: "stack", stackId: "stack_1" });
});
