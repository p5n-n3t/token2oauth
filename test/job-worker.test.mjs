import test from "node:test";
import assert from "node:assert/strict";
import { createJobWorker } from "../dist/job-worker.js";

const ok = (accountId, value = {}) => ({ classification: "accepted", accountId, value });
const op = (id, accountId, overrides = {}) => ({
  operationId: id, attemptId: `attempt-${id}`, generation: 1, selectedAccountId: accountId,
  kind: "chat_session", sessionId: `session-${accountId}`, input: {
    instructions: `work ${id}`, clientMessageId: `client-${id}`, dispatchAt: "2026-10-10T00:00:00Z",
  }, ...overrides,
});
const pythonObservation = (id, accountId, dispatchAt) => ({
  operationId: id, attemptId: `attempt-${id}`, generation: 1, selectedAccountId: accountId,
  kind: "observe_session", sessionId: `session-${accountId}`, providerTaskId: "provider-task",
  input: { sessionId: `session-${accountId}`, clientMessageId: `client-${id}`, dispatchAt,
    expectedMarker: "EXPECTED", providerTaskId: "provider-task", stackId: "stack-1", provider: "auto",
    workspace: "workspace-1", model: "gpt-6-luna" },
});
function adapter(accountId, overrides = {}) {
  return {
    accountId,
    sessionStatus: async () => ok(accountId, { isOwner: true, canSendMessage: true, model: "gpt-6-luna", status: "idle" }),
    sessionTranscript: async () => ok(accountId, { messages: [] }),
    sendMessage: async () => ok(accountId),
    stopSession: async () => ok(accountId),
    ...overrides,
  };
}
function harness(operations, overrides = {}) {
  const claims = [...operations];
  const resultBodies = [];
  const bridge = {
    async request(method, route, body) {
      if (route === "/v1/operations/claim") return claims.shift();
      if (route.endsWith("/result")) { resultBodies.push(structuredClone(body)); return { state: body.outcome }; }
      throw new Error("unexpected route");
    },
  };
  const worker = createJobWorker({
    bridge, adapterFactory: (accountId) => adapter(accountId), isAccountEligible: () => true,
    workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 2, pollIntervalMs: 20,
    ...overrides,
  });
  return { worker, resultBodies, claims };
}
const until = async (predicate, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("dispatches pinned accounts concurrently without exceeding configured capacity", async () => {
  let current = 0; let peak = 0; const sent = [];
  const items = [op("one", "account-a"), op("two", "account-b"), op("three", "account-c")];
  const { worker, resultBodies } = harness(items, {
    maxConcurrent: 2,
    adapterFactory: (accountId) => adapter(accountId, { sendMessage: async (sessionId, message, clientMessageId) => {
      current++; peak = Math.max(peak, current); sent.push({ accountId, sessionId, message, clientMessageId });
      await new Promise((resolve) => setTimeout(resolve, 30)); current--;
      return ok(accountId);
    } }),
  });
  worker.start();
  await until(() => resultBodies.length === 3);
  await worker.stop();
  assert.equal(peak, 2);
  assert.deepEqual(sent.map((v) => v.accountId).sort(), ["account-a", "account-b", "account-c"]);
  assert.equal(resultBodies.every((body) => body.outcome === "accepted"), true);
});

test("ambiguous chat mutation is never replayed", async () => {
  let sends = 0;
  const { worker, resultBodies } = harness([op("ambiguous", "account-a")], {
    adapterFactory: (accountId) => adapter(accountId, { sendMessage: async () => { sends++; return { classification: "ambiguous", accountId }; } }),
  });
  worker.start(); await until(() => resultBodies.length === 1); await worker.tick(); await worker.stop();
  assert.equal(sends, 1);
  assert.equal(resultBodies[0].outcome, "ambiguous");
});

test("a failed result acknowledgment retries only the stored receipt", async () => {
  let sends = 0; let resultAttempts = 0; const receipts = [];
  let claimAvailable = true;
  const bridge = { async request(_method, route, body) {
    if (route === "/v1/operations/claim") {
      if (!claimAvailable) return undefined;
      claimAvailable = false;
      return op("receipt", "account-a");
    }
    receipts.push(structuredClone(body));
    if (++resultAttempts === 1) throw Object.assign(new Error("lost ack"), { code: "transport_error" });
    return { state: body.outcome };
  } };
  const retryWorker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sends++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1, pollIntervalMs: 20 });
  retryWorker.start(); await until(() => resultAttempts >= 2); await retryWorker.stop();
  assert.equal(sends, 1);
  assert.deepEqual(receipts[0], receipts[1]);
});

test("shutdown aborts a pending claim and does not dispatch it when it returns", async () => {
  let resolveClaim; let sent = 0;
  const bridge = { request(_method, route) {
    if (route.endsWith("/claim")) return new Promise((resolve) => { resolveClaim = resolve; });
    return Promise.resolve({});
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sent++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => resolveClaim); const stopping = worker.stop(); resolveClaim(op("late", "account-a")); await stopping;
  assert.equal(sent, 0);
});

test("observe_session ignores assistant messages older than durable dispatchAt", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const observation = pythonObservation("observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: "old", timestamp: "2026-10-09T23:59:59Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.result.status, "idle");
  assert.equal("assistantText" in posted.result, false);
});

test("observe_session returns only the newest bounded assistant result after dispatchAt", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const observation = pythonObservation("fresh-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 1, latestAssistantComplete: true,
      messages: [
        { role: "assistant", content: "first", timestamp: "2026-10-10T00:01:00Z", complete: true },
        { role: "assistant", content: [{ type: "text", text: "latest" }], timestamp: "2026-10-10T00:02:00Z", complete: true },
      ] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.result.assistantText, "latest");
  assert.equal(posted.outcome, "accepted");
  assert.equal(posted.result.status, "idle");
  assert.equal(posted.result.assistantAt, Date.parse("2026-10-10T00:02:00Z") / 1_000);
  assert.equal(typeof posted.result.assistantAt, "number");
});

test("observe_session preserves complete assistant text longer than the identifier limit", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  const fullText = `EXPECTED ${"x".repeat(3_000)}`;
  const observation = pythonObservation("long-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: fullText, timestamp: "2026-10-10T00:02:00Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "accepted");
  assert.equal(posted.result.assistantText, fullText);
});

test("observe_session omits oversized assistant output using a UTF-8 byte bound", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  // 10,923 three-byte characters exceed 32 KiB despite having fewer than 32,768 JS chars.
  const tooLarge = `EXPECTED${"€".repeat(10_923)}`;
  const observation = pythonObservation("oversize-observe", "account-a", dispatchAt);
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
    sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 0, latestAssistantComplete: true,
      messages: [{ role: "assistant", content: tooLarge, timestamp: "2026-10-10T00:02:00Z", complete: true }] }),
  }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "accepted");
  assert.equal("assistantText" in posted.result, false);
  assert.equal("assistantAt" in posted.result, false);
});

test("observe_session does not fall back to an older complete answer when the latest is incomplete", async () => {
  const dispatchAt = Date.parse("2026-10-10T00:00:00Z") / 1_000;
  for (const [index, latestAssistantComplete, messageComplete] of [[0, false, false], [1, true, false], [2, false, true]]) {
    let posted;
    const observation = pythonObservation(`incomplete-latest-${index}`, "account-a", dispatchAt);
    const bridge = { async request(_method, route, body) {
      if (route.endsWith("/claim")) return observation;
      posted = body; return {};
    } };
    const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, {
      sessionTranscript: async () => ok(id, { shape: "messages", latestAssistantIndex: 1, latestAssistantComplete,
        incomplete: true, messages: [
          { role: "assistant", content: "OLDER VALID MARKER", timestamp: dispatchAt + 5, complete: true },
          { role: "assistant", contentOmitted: "oversized", timestamp: dispatchAt + 10, complete: messageComplete },
        ] }),
    }), isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
    worker.start(); await until(() => posted); await worker.stop();
    assert.equal(posted.outcome, "accepted");
    assert.equal(posted.result.status, "idle");
    assert.equal("assistantText" in posted.result, false);
    assert.equal("assistantAt" in posted.result, false);
  }
});

test("observe_session rejects an invalid durable dispatch timestamp", async () => {
  const observation = pythonObservation("bad-dispatch-time", "account-a", "yesterday-ish");
  let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return observation;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id), isAccountEligible: () => true,
    workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(posted.outcome, "rejected");
  assert.equal(posted.errorClass, "invalid_dispatch_timestamp");
});

test("fresh create_task remains disabled unless explicitly enabled", async () => {
  const fresh = { ...op("fresh", "account-a"), kind: "create_task", input: { stackId: "stack", title: "Task", instructions: "bounded task" } };
  let posted; let creates = 0;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return fresh;
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { createTask: async () => { creates++; return ok(id); } }),
    isAccountEligible: () => true, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(creates, 0);
  assert.equal(posted.outcome, "rejected");
  assert.equal(posted.errorClass, "fresh_operations_disabled");
});

test("current account ineligibility prevents chat send", async () => {
  let checks = 0; let sends = 0; let posted;
  const bridge = { async request(_method, route, body) {
    if (route.endsWith("/claim")) return op("disabled", "account-a");
    posted = body; return {};
  } };
  const worker = createJobWorker({ bridge, adapterFactory: (id) => adapter(id, { sendMessage: async () => { sends++; return ok(id); } }),
    isAccountEligible: () => ++checks === 1, workerId: "worker-test", allowedModels: ["gpt-6-luna"], maxConcurrent: 1 });
  worker.start(); await until(() => posted); await worker.stop();
  assert.equal(checks, 2);
  assert.equal(sends, 0);
  assert.equal(posted.outcome, "rejected");
});
