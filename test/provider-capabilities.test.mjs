import test from "node:test";
import assert from "node:assert/strict";
import {
  asyncToolRole,
  canonicalJson,
  collectToolInventory,
  createCapabilitySnapshot,
  diffSnapshots,
  observed,
  PROVIDER_PROFILES,
  providerProfile,
  redactUrl,
  surfacesCompatible,
  toolSchemaHash,
  unknown,
} from "../dist/provider-capabilities.js";

const tool = (name, schema = { type: "object" }) => ({ name, description: `${name} tool`, inputSchema: schema });

function pagedFetcher(pages) {
  const calls = [];
  const fetcher = async (cursor) => {
    calls.push(cursor);
    const index = cursor === undefined ? 0 : Number(cursor.replace("c", ""));
    return pages[index];
  };
  return { fetcher, calls };
}

let clock = 1_000;
const now = () => ++clock;

test("collects a paginated inventory following nextCursor", async () => {
  const { fetcher, calls } = pagedFetcher([
    { tools: [tool("a"), tool("b")], nextCursor: "c1" },
    { tools: [tool("c")], nextCursor: "c2" },
    { tools: [tool("d")] },
  ]);
  const inventory = await collectToolInventory(fetcher, { now });
  assert.deepEqual(calls, [undefined, "c1", "c2"]);
  assert.deepEqual(inventory.tools.map((t) => [t.name, t.page]), [["a", 0], ["b", 0], ["c", 1], ["d", 2]]);
  assert.equal(inventory.pages, 3);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.nextCursor, undefined);
  assert.ok(inventory.finishedAt > inventory.startedAt);
});

test("stops on cursor loops, page caps and fetch errors with partial results", async () => {
  const loop = await collectToolInventory(async (cursor) => ({ tools: [tool(`t${cursor ?? 0}`)], nextCursor: "same" }), { now });
  assert.equal(loop.complete, false);
  assert.match(loop.incompleteReason, /cursor loop/);
  assert.equal(loop.tools.length, 2);

  let n = 0;
  const capped = await collectToolInventory(async () => ({ tools: [tool(`t${n}`)], nextCursor: `c${++n}` }), { maxPages: 3, now });
  assert.equal(capped.complete, false);
  assert.equal(capped.pages, 3);
  assert.equal(capped.nextCursor, "c3");

  const failing = await collectToolInventory(async (cursor) => {
    if (cursor) throw new Error("upstream 503");
    return { tools: [tool("a")], nextCursor: "c1" };
  }, { now });
  assert.equal(failing.complete, false);
  assert.match(failing.incompleteReason, /upstream 503/);
  assert.deepEqual(failing.tools.map((t) => t.name), ["a"]);
});

test("dedupes tools, skips malformed entries and enforces the tool cap", async () => {
  const inventory = await collectToolInventory(async (cursor) =>
    cursor
      ? { tools: [tool("a", { type: "string" }), null, { name: 5 }, { name: "" }, tool("b")] }
      : { tools: [tool("a")], nextCursor: "c1" },
  { now });
  assert.deepEqual(inventory.tools.map((t) => t.name), ["a", "b"]);
  assert.deepEqual(inventory.duplicateNames, ["a"]);
  assert.equal(inventory.tools[0].schemaHash, toolSchemaHash(tool("a")));

  const capped = await collectToolInventory(async () => ({ tools: [tool("a"), tool("b"), tool("c")] }), { maxTools: 2, now });
  assert.equal(capped.complete, false);
  assert.equal(capped.tools.length, 2);
});

test("schema hashes are key-order independent and change with the schema", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } }), '{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  const a = toolSchemaHash({ name: "t", inputSchema: { type: "object", properties: { q: { type: "string" } } } });
  const b = toolSchemaHash({ name: "t", inputSchema: { properties: { q: { type: "string" } }, type: "object" } });
  const c = toolSchemaHash({ name: "t", inputSchema: { properties: { q: { type: "number" } }, type: "object" } });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("snapshots keep provider and account distinct and default identity/quota to unknown", async () => {
  const inventory = await collectToolInventory(async () => ({ tools: [tool("web_search_exa")] }), { now });
  const snapshot = createCapabilitySnapshot({
    provider: "exa",
    accountId: "acct_1",
    accountLabel: "team A",
    serverUrl: "https://mcp.exa.ai/mcp?exaApiKey=sk-live-123&tools=web_search_exa",
    inventory,
    now,
  });
  assert.equal(snapshot.provider, "exa");
  assert.equal(snapshot.accountId, "acct_1");
  assert.equal(snapshot.identity.known, false);
  assert.equal(snapshot.quota.known, false);
  assert.match(snapshot.quota.reason, /no documented quota endpoint/);
  assert.equal(snapshot.serverInfo.known, false);
  assert.ok(!snapshot.serverUrl.includes("sk-live-123"));
  assert.ok(snapshot.serverUrl.includes("tools=web_search_exa"));
  assert.equal(snapshot.inventory.source, "tools/list");
  assert.equal(snapshot.inventory.fetchedAt, inventory.finishedAt);
  assert.ok(snapshot.capturedAt >= snapshot.inventory.fetchedAt);
  assert.throws(() => createCapabilitySnapshot({ provider: "exa", accountId: "", serverUrl: "https://x", inventory }));
});

test("observed values carry provenance; unknown values carry a reason", () => {
  assert.deepEqual(observed({ remaining: 5 }, "agent_run usage", 42), { known: true, value: { remaining: 5 }, observedAt: 42, source: "agent_run usage" });
  assert.deepEqual(unknown("not exposed"), { known: false, reason: "not exposed" });
});

test("redactUrl strips userinfo and secret-looking query parameters", () => {
  assert.equal(redactUrl("not a url"), "[invalid-url]");
  const out = redactUrl("https://user:pw@host.example/mcp?api_key=1&token=2&x-api-key=3&cursor=ok");
  assert.ok(!out.includes("user") && !out.includes("pw@"));
  assert.ok(!/=1|=2|=3/.test(out));
  assert.ok(out.includes("cursor=ok"));
  assert.equal(redactUrl("https://h.example/fc-abc123/v2/mcp", /^fc-/), "https://h.example/REDACTED/v2/mcp");
});

async function snap(accountId, toolsList, opts = {}) {
  const inventory = await collectToolInventory(async () => ({ tools: toolsList }), { now });
  if (opts.incomplete) {
    inventory.complete = false;
    inventory.incompleteReason = "test";
  }
  return createCapabilitySnapshot({ provider: opts.provider ?? "firecrawl", accountId, serverUrl: "https://mcp.firecrawl.dev/v2/mcp", inventory, now });
}

test("diffSnapshots reports added, removed and schema-changed tools", async () => {
  const before = await snap("a", [tool("x"), tool("y")]);
  const after = await snap("a", [tool("y", { type: "string" }), tool("z")]);
  const diff = diffSnapshots(before, after);
  assert.deepEqual(diff.added, ["z"]);
  assert.deepEqual(diff.removed, ["x"]);
  assert.deepEqual(diff.schemaChanged, ["y"]);
  assert.equal(diff.identical, false);
  const same = diffSnapshots(before, await snap("b", [tool("y"), tool("x")]));
  assert.equal(same.identical, true);
  assert.equal(diffSnapshots(before, await snap("b", [tool("x"), tool("y")], { incomplete: true })).partial, true);
});

test("surfacesCompatible refuses mixed providers, partial inventories and differing surfaces", async () => {
  const a = await snap("a", [tool("x")]);
  assert.equal(surfacesCompatible([a]).compatible, true);
  assert.equal(surfacesCompatible([a, await snap("b", [tool("x")])]).compatible, true);
  assert.match(surfacesCompatible([a, await snap("b", [tool("x")], { provider: "exa" })]).reason, /mixed providers/);
  assert.match(surfacesCompatible([a, await snap("b", [tool("x")], { incomplete: true })]).reason, /incomplete/);
  assert.match(surfacesCompatible([a, await snap("b", [tool("x"), tool("y")])]).reason, /differ/);
});

test("provider profiles document tools without claiming a quota endpoint", () => {
  for (const profile of Object.values(PROVIDER_PROFILES)) {
    assert.equal(profile.quotaEndpointDocumented, false);
    assert.ok(profile.documentedTools.length > 0);
  }
  assert.deepEqual(PROVIDER_PROFILES.lightsprint.documentedTools, ["lightsprint_api"]);
  assert.equal(providerProfile("toString"), undefined);
  assert.equal(providerProfile("nope"), undefined);
  assert.equal(asyncToolRole("firecrawl", "firecrawl_agent"), "start");
  assert.equal(asyncToolRole("firecrawl", "firecrawl_agent_status"), "status");
  assert.equal(asyncToolRole("exa", "agent_run"), "both");
  assert.equal(asyncToolRole("exa", "web_search_exa"), undefined);
  assert.ok(Object.isFrozen(PROVIDER_PROFILES));
});
