import test from "node:test";
import assert from "node:assert/strict";
import {
  compileToolPolicy,
  evaluateToolCall,
  filterTools,
  filterServerMessage,
  gateClientMessage,
  isToolAllowed,
  normalizeApiPath,
  PolicyConfigError,
  POLICY_ERROR_CODE,
} from "../dist/tool-policy.js";

const tools = [
  { name: "web_search_exa", inputSchema: { type: "object" } },
  { name: "web_fetch_exa", inputSchema: { type: "object" } },
  { name: "agent_run", inputSchema: { type: "object" } },
  { name: "lightsprint_api", inputSchema: { type: "object" } },
];

const lightsprintPolicy = compileToolPolicy({
  endpoints: [
    {
      tool: "lightsprint_api",
      bindings: { workspaceId: "ws_1" },
      rules: [
        { id: "task-read", methods: ["GET"], path: "/api/tasks/{taskId}" },
        { id: "task-edit", methods: ["PATCH"], path: "/api/tasks/{taskId}" },
        { id: "resolve", methods: ["GET"], path: "/api/workspaces/{workspaceId}/tasks/resolve", query: ["ref"] },
        { id: "comment", methods: ["POST"], path: "/api/tasks/*/comments" },
      ],
    },
  ],
});

const call = (method, path, body) => ({ name: "lightsprint_api", arguments: body === undefined ? { method, path } : { method, path, body } });

test("no policy is a passthrough for list, call and JSON-RPC helpers", () => {
  assert.equal(filterTools(undefined, tools), tools);
  assert.deepEqual(evaluateToolCall(undefined, { name: "anything", arguments: { x: 1 } }), { allowed: true });
  assert.deepEqual(evaluateToolCall(undefined, call("DELETE", "/../../etc/passwd")), { allowed: true });
  const payload = [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "x" } }];
  const gated = gateClientMessage(undefined, payload);
  assert.equal(gated.forward, payload);
  assert.deepEqual(gated.rejections, []);
  const response = { jsonrpc: "2.0", id: 1, result: { tools } };
  assert.equal(filterServerMessage(undefined, response, new Map([[1, "tools/list"]])), response);
});

test("empty policy object changes nothing", () => {
  const empty = compileToolPolicy({});
  assert.deepEqual(filterTools(empty, tools).map((t) => t.name), tools.map((t) => t.name));
  assert.equal(evaluateToolCall(empty, call("DELETE", "/api/anything")).allowed, true);
});

test("allowlist filters tools/list and rejects other tools/call", () => {
  const policy = compileToolPolicy({ allowTools: ["web_search_exa", "web_fetch_exa"] });
  assert.deepEqual(filterTools(policy, tools).map((t) => t.name), ["web_search_exa", "web_fetch_exa"]);
  assert.equal(evaluateToolCall(policy, { name: "web_search_exa", arguments: {} }).allowed, true);
  const denied = evaluateToolCall(policy, { name: "agent_run", arguments: {} });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, "tool-not-allowed");
});

test("denylist wins over allowlist and plain policies are compiled on demand", () => {
  const raw = { allowTools: ["agent_run", "web_search_exa"], denyTools: ["agent_run"] };
  assert.deepEqual(filterTools(raw, tools).map((t) => t.name), ["web_search_exa"]);
  assert.equal(isToolAllowed(raw, "agent_run").code, "tool-denied");
});

test("tool names are matched exactly (no case or whitespace bypass)", () => {
  const policy = compileToolPolicy({ denyTools: ["agent_run"] });
  for (const name of ["Agent_Run", "agent_run ", " agent_run"]) {
    // Variants are different tools to the gateway; upstream rejects unknown names.
    assert.equal(evaluateToolCall(policy, { name }).allowed, true);
  }
  assert.equal(evaluateToolCall(policy, { name: "agent_run" }).allowed, false);
  const allow = compileToolPolicy({ allowTools: ["web_search_exa"] });
  for (const name of ["WEB_SEARCH_EXA", "web_search_exa\u0000", "", undefined, 42]) {
    assert.equal(evaluateToolCall(allow, { name }).allowed, false, `name ${String(name)}`);
  }
});

test("denying lightsprint_api disables the whole API regardless of endpoint rules", () => {
  const policy = compileToolPolicy({
    denyTools: ["lightsprint_api"],
    endpoints: [{ rules: [{ methods: ["GET"], path: "/api/tasks/*" }] }],
  });
  assert.ok(!filterTools(policy, tools).some((t) => t.name === "lightsprint_api"));
  assert.equal(evaluateToolCall(policy, call("GET", "/api/tasks/abc")).code, "tool-denied");
});

test("an empty endpoint allowlist hides the tool and denies every call", () => {
  const policy = compileToolPolicy({ endpoints: [{ rules: [] }] });
  assert.ok(!filterTools(policy, tools).some((t) => t.name === "lightsprint_api"));
  assert.equal(evaluateToolCall(policy, call("GET", "/api/tasks/abc")).code, "endpoint-not-allowed");
});

test("endpoint allowlist permits listed method/path pairs", () => {
  assert.deepEqual(evaluateToolCall(lightsprintPolicy, call("GET", "/api/tasks/abc")), {
    allowed: true,
    rule: "task-read",
    normalizedPath: "/api/tasks/abc",
  });
  assert.equal(evaluateToolCall(lightsprintPolicy, call("PATCH", "/api/tasks/abc", { title: "x" })).rule, "task-edit");
  assert.equal(evaluateToolCall(lightsprintPolicy, call("POST", "/api/tasks/abc/comments", { body: "hi" })).rule, "comment");
  assert.equal(
    evaluateToolCall(lightsprintPolicy, call("GET", "/api/workspaces/ws_1/tasks/resolve?ref=LW-1")).rule,
    "resolve",
  );
  // One trailing slash is tolerated and canonicalized.
  assert.equal(evaluateToolCall(lightsprintPolicy, call("GET", "/api/tasks/abc/")).normalizedPath, "/api/tasks/abc");
});

test("endpoint allowlist rejects unlisted methods, paths, queries and bodies", () => {
  const cases = [
    [call("DELETE", "/api/tasks/abc"), "method-not-allowed"],
    [call("get", "/api/tasks/abc"), "method-not-allowed"],
    [call("TRACE", "/api/tasks/abc"), "method-not-allowed"],
    [call("GET", "/api/tasks"), "endpoint-not-allowed"],
    [call("GET", "/api/tasks/abc/comments"), "method-not-allowed"],
    [call("GET", "/api/tasks/abc/comments/1"), "endpoint-not-allowed"],
    [call("GET", "/api/billing/accounts/1"), "endpoint-not-allowed"],
    [call("GET", "/api/tasks/abc?expand=all"), "query-not-allowed"],
    [call("GET", "/api/workspaces/ws_1/tasks/resolve?ref=x&admin=1"), "query-not-allowed"],
    [call("GET", "/api/tasks/abc", { x: 1 }), "body-not-allowed"],
    [call("PATCH", "/api/tasks/abc", "raw"), "invalid-arguments"],
    [call("PATCH", "/api/tasks/abc", [1]), "invalid-arguments"],
    [{ name: "lightsprint_api", arguments: { method: "GET", path: "/api/tasks/abc", url: "http://evil" } }, "invalid-arguments"],
    [{ name: "lightsprint_api", arguments: null }, "invalid-arguments"],
    [{ name: "lightsprint_api", arguments: { method: "GET" } }, "invalid-path"],
    [{ name: "lightsprint_api", arguments: { method: ["GET"], path: "/api/tasks/abc" } }, "invalid-arguments"],
  ];
  for (const [input, code] of cases) {
    const decision = evaluateToolCall(lightsprintPolicy, input);
    assert.equal(decision.allowed, false, JSON.stringify(input));
    assert.equal(decision.code, code, JSON.stringify(input));
  }
});

test("bound placeholders pin calls to one workspace", () => {
  const other = evaluateToolCall(lightsprintPolicy, call("GET", "/api/workspaces/ws_2/tasks/resolve?ref=LW-1"));
  assert.equal(other.allowed, false);
  assert.equal(other.code, "endpoint-not-allowed");
  // Encoding the bound value does not change what it decodes to, so it still matches only ws_1.
  assert.equal(evaluateToolCall(lightsprintPolicy, call("GET", "/api/workspaces/ws%5F1/tasks/resolve")).allowed, true);
  assert.equal(evaluateToolCall(lightsprintPolicy, call("GET", "/api/workspaces/ws%5F2/tasks/resolve")).allowed, false);
});

test("encoded traversal, proxying and smuggling attempts are rejected", () => {
  const attacks = [
    "/api/tasks/../billing",
    "/api/tasks/./abc",
    "/api/tasks/%2e%2e/billing",
    "/api/tasks/%2E%2E/billing",
    "/api/tasks/.%2e/billing",
    "/api/tasks/%252e%252e/billing",
    "/api/tasks/abc%2fcomments",
    "/api/tasks/abc%2Fcomments",
    "/api/tasks/abc%5c..%5cbilling",
    "/api/tasks\\..\\billing",
    "/api/tasks//abc",
    "//evil.example/api/tasks/abc",
    "https://evil.example/api/tasks/abc",
    "http:/api/tasks/abc",
    "api/tasks/abc",
    "/api/tasks/abc#frag",
    "/api/tasks/abc%00",
    "/api/tasks/abc\u0000",
    "/api/tasks/abc\r\nHost: evil",
    "/api/tasks/abc%0d%0a",
    "/api/tasks/abc;x=1",
    "/api/tasks/%E2%80%A8",
    "/api/tasks/．．",
    "/api/tasks/%",
    "/api/tasks/%zz",
    "/api/tasks/...",
    "/api/tasks/a b",
    "/apix/tasks/abc",
    "/API/tasks/abc",
    "/api",
    "",
    "/api/tasks/" + "a".repeat(5000),
  ];
  for (const path of attacks) {
    const decision = evaluateToolCall(lightsprintPolicy, call("GET", path));
    assert.equal(decision.allowed, false, `should reject ${JSON.stringify(path)}`);
  }
});

test("normalizeApiPath canonicalizes safe encodings and parses queries", () => {
  const result = normalizeApiPath("/api/tasks/ab%2Dc/?ref=LW%2D1&tag=a&tag=b");
  assert.equal(result.ok, true);
  assert.equal(result.value.path, "/api/tasks/ab-c");
  assert.deepEqual(result.value.query.get("tag"), ["a", "b"]);
  assert.deepEqual(result.value.query.get("ref"), ["LW-1"]);
  assert.equal(normalizeApiPath(42).ok, false);
});

test("policy compilation rejects open-proxy and malformed rules", () => {
  const bad = [
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/**" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/other/x" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/../x" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/a%2fb" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/a?x=1" }] }] },
    { endpoints: [{ rules: [{ methods: ["GET"], path: "/api/a*" }] }] },
    { endpoints: [{ rules: [{ methods: ["CONNECT"], path: "/api/a" }] }] },
    { endpoints: [{ rules: [{ methods: [], path: "/api/a" }] }] },
    { endpoints: [{ bindings: { workspaceId: "../x" }, rules: [] }] },
    { endpoints: [{ prefix: "api", rules: [] }] },
    { endpoints: [{ rules: [] }, { rules: [] }] },
    { allowTools: "lightsprint_api" },
    { denyTools: [""] },
  ];
  for (const policy of bad) {
    assert.throws(() => compileToolPolicy(policy), PolicyConfigError, JSON.stringify(policy));
  }
});

test("custom endpoint tool and prefix are supported", () => {
  const policy = compileToolPolicy({
    endpoints: [{ tool: "internal_api", prefix: "/v1/", rules: [{ methods: ["GET"], path: "/v1/status" }] }],
  });
  assert.equal(evaluateToolCall(policy, { name: "internal_api", arguments: { method: "GET", path: "/v1/status" } }).allowed, true);
  assert.equal(evaluateToolCall(policy, { name: "internal_api", arguments: { method: "GET", path: "/api/status" } }).allowed, false);
  // lightsprint_api has no endpoint policy here, so only tool-level rules apply.
  assert.equal(evaluateToolCall(policy, call("DELETE", "/api/x")).allowed, true);
});

test("gateClientMessage rejects blocked calls and forwards the rest of a batch", () => {
  const policy = compileToolPolicy({ allowTools: ["web_search_exa"] });
  const batch = [
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "web_search_exa", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "agent_run", arguments: {} } },
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    { jsonrpc: "2.0", method: "tools/call", params: { name: "agent_run" } },
  ];
  const { forward, rejections } = gateClientMessage(policy, batch);
  assert.deepEqual(forward.map((m) => m.id), [1, 3]);
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].id, 2);
  assert.equal(rejections[0].error.code, POLICY_ERROR_CODE);
  assert.equal(rejections[0].error.data.code, "tool-not-allowed");

  const single = gateClientMessage(policy, batch[1]);
  assert.equal(single.forward, null);
  assert.equal(single.rejections.length, 1);
  assert.equal(gateClientMessage(policy, batch[0]).forward, batch[0]);
});

test("gateClientMessage blocks a call missing params instead of forwarding it", () => {
  const policy = compileToolPolicy({ allowTools: ["web_search_exa"] });
  const { forward, rejections } = gateClientMessage(policy, { jsonrpc: "2.0", id: 9, method: "tools/call" });
  assert.equal(forward, null);
  assert.equal(rejections[0].error.data.code, "invalid-arguments");
});

test("filterServerMessage only filters responses to tools/list and does not mutate input", () => {
  const policy = compileToolPolicy({ denyTools: ["agent_run"] });
  const listResponse = { jsonrpc: "2.0", id: "a", result: { tools: [...tools], nextCursor: "c2" } };
  const otherResponse = { jsonrpc: "2.0", id: "b", result: { tools: [...tools] } };
  const methods = new Map([["a", "tools/list"], ["b", "resources/list"]]);
  const [filtered, untouched] = filterServerMessage(policy, [listResponse, otherResponse], methods);
  assert.deepEqual(filtered.result.tools.map((t) => t.name), ["web_search_exa", "web_fetch_exa", "lightsprint_api"]);
  assert.equal(filtered.result.nextCursor, "c2");
  assert.equal(untouched, otherResponse);
  assert.equal(listResponse.result.tools.length, 4);
});

test("hideDenied=false keeps tools visible but still rejects calls", () => {
  const policy = compileToolPolicy({ denyTools: ["agent_run"], hideDenied: false });
  assert.equal(filterTools(policy, tools).length, 4);
  assert.equal(evaluateToolCall(policy, { name: "agent_run" }).allowed, false);
});
