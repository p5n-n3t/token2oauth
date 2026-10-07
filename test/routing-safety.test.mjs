import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRetryFailure,
  decideRetry,
  isReplaySafeRequest,
  mergeIncomingQuery,
  parseRetryAfterMs,
  taskIdFromFollowupRequest,
  taskIdFromResponse,
  UpstreamOwnershipRegistry,
} from "../dist/routing-safety.js";

test("classifies transport, HTTP, JSON-RPC, and tool-result failures", () => {
  assert.equal(classifyRetryFailure({ kind: "transport" }).retryable, true);
  assert.equal(classifyRetryFailure({ kind: "http", status: 503 }).retryable, true);
  assert.equal(classifyRetryFailure({ kind: "http", status: 400 }).retryable, false);
  assert.equal(classifyRetryFailure({ kind: "json-rpc", code: -32603 }).retryable, false);
  assert.equal(
    classifyRetryFailure({ kind: "json-rpc", code: -32005 }, {
      retryableJsonRpcCodes: [-32005],
    }).retryable,
    true,
  );
  assert.equal(
    classifyRetryFailure({ kind: "tool-result", isError: true }).retryable,
    true,
  );
  assert.equal(
    classifyRetryFailure({ kind: "tool-result", isError: false }).retryable,
    false,
  );
});

test("parses and bounds Retry-After seconds and HTTP dates", () => {
  assert.equal(parseRetryAfterMs("2", { maxMs: 10_000 }), 2_000);
  assert.equal(parseRetryAfterMs("120", { maxMs: 5_000 }), 5_000);
  assert.equal(
    parseRetryAfterMs("Thu, 01 Jan 1970 00:00:05 GMT", { nowMs: 2_000, maxMs: 10_000 }),
    3_000,
  );
  assert.equal(parseRetryAfterMs("-1"), undefined);
  assert.equal(parseRetryAfterMs("not-a-date"), undefined);
});

test("retries known reads while rejecting mutating and unknown tool calls", () => {
  assert.equal(isReplaySafeRequest({ rpcMethod: "resources/read" }), true);
  assert.equal(isReplaySafeRequest({ rpcMethod: "tools/call", toolName: "lookup" }, ["lookup"]), true);
  assert.equal(isReplaySafeRequest({ rpcMethod: "tools/call", toolName: "delete" }, ["lookup"]), false);
  assert.equal(isReplaySafeRequest({ rpcMethod: "tools/call", toolName: "unknown" }), false);
  assert.equal(isReplaySafeRequest({ rpcMethod: "resources/write" }), false);

  const denied = decideRetry({
    failure: { kind: "http", status: 503 },
    request: { rpcMethod: "tools/call", toolName: "charge-card" },
    elapsedMs: 0,
    deadlineMs: 5_000,
  });
  assert.equal(denied.retry, false);
  assert.match(denied.reason, /mutating or not explicitly known/);
});

test("honors bounded Retry-After and the total elapsed deadline", () => {
  const retry = decideRetry({
    failure: { kind: "http", status: 429, retryAfter: "45" },
    request: { rpcMethod: "resources/read" },
    elapsedMs: 1_000,
    deadlineMs: 40_000,
    maxRetryAfterMs: 2_000,
  });
  assert.equal(retry.retry, true);
  assert.equal(retry.delayMs, 2_000);

  const deadline = decideRetry({
    failure: { kind: "http", status: 429, retryAfter: "5" },
    request: { rpcMethod: "resources/read" },
    elapsedMs: 8_000,
    deadlineMs: 10_000,
  });
  assert.equal(deadline.retry, false);
  assert.match(deadline.reason, /deadline/);
});

test("preserves configured upstream query parameters and appends incoming values", () => {
  const url = mergeIncomingQuery(
    "https://upstream.example/mcp?tenant=primary&tag=one",
    "http://gateway.local/mcp?client=chatgpt&tag=two&tag=three",
  );
  assert.deepEqual([...url.searchParams], [
    ["tenant", "primary"],
    ["tag", "one"],
    ["client", "chatgpt"],
    ["tag", "two"],
    ["tag", "three"],
  ]);
});

test("extracts task handles from follow-up requests and MCP task results", () => {
  assert.equal(taskIdFromFollowupRequest({
    method: "tasks/result",
    params: { taskId: "task-123" },
  }), "task-123");
  assert.equal(taskIdFromFollowupRequest({
    method: "tools/call",
    params: { taskId: "not-a-followup" },
  }), undefined);
  assert.equal(taskIdFromResponse({ result: { task: { taskId: "task-123" } } }), "task-123");
});

test("session affinity is enforced independently of pool strategy", () => {
  const owners = new UpstreamOwnershipRegistry();
  const unknown = owners.resolve({ sessionId: "session-not-seen" });
  assert.deepEqual(unknown, {
    kind: "unknown-session",
    sessionId: "session-not-seen",
  });
  assert.deepEqual(owners.authorize("account-A", unknown), {
    allowed: false,
    reason: "unknown-session",
  });

  owners.bindSession("session-A", "account-A");
  const resolution = owners.resolve({ sessionId: "session-A" });
  assert.deepEqual(resolution, {
    kind: "owner",
    accountId: "account-A",
    source: "session",
  });
  assert.deepEqual(owners.authorize("account-B", resolution), {
    allowed: false,
    reason: "foreign-owner",
    ownerAccountId: "account-A",
  });
  assert.deepEqual(owners.authorize("account-A", resolution), { allowed: true });
});

test("unknown or foreign task follow-ups cannot reach a different upstream owner", () => {
  const owners = new UpstreamOwnershipRegistry();
  const followup = { method: "tasks/get", params: { taskId: "job-A" } };
  const unknown = owners.resolve({ request: followup });
  assert.deepEqual(unknown, { kind: "unknown-task", taskId: "job-A" });
  assert.deepEqual(owners.authorize("account-A", unknown), {
    allowed: false,
    reason: "unknown-task",
  });

  owners.bindTask("job-A", "account-A");
  const owned = owners.resolve({ request: followup });
  assert.deepEqual(owners.authorize("account-B", owned), {
    allowed: false,
    reason: "foreign-owner",
    ownerAccountId: "account-A",
  });
});

test("conflicting session and task owners are blocked and bindings cannot be reassigned", () => {
  const owners = new UpstreamOwnershipRegistry();
  assert.deepEqual(owners.bindSession("session-A", "account-A"), {
    ok: true,
    ownerAccountId: "account-A",
  });
  assert.deepEqual(owners.bindSession("session-A", "account-B"), {
    ok: false,
    ownerAccountId: "account-A",
  });
  owners.bindTask("job-A", "account-B");
  const conflict = owners.resolve({
    sessionId: "session-A",
    request: { method: "tasks/get", params: { taskId: "job-A" } },
  });
  assert.equal(conflict.kind, "conflict");
  assert.deepEqual(owners.authorize("account-A", conflict), {
    allowed: false,
    reason: "ownership-conflict",
  });
});
