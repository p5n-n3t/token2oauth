import test from "node:test";
import assert from "node:assert/strict";
import {
  PoolSchemaError,
  migrateLegacyPool,
  validatePools,
  validateToolSets,
} from "../dist/pool-schema.js";

const settings = () => ({
  upstreamUrl: "https://provider.example/mcp",
  upstreamAuthHeader: "authorization",
  upstreamAuthScheme: "Bearer",
  requestTimeoutMs: 120_000,
  maxFailoverAttempts: 3,
  failoverStateful: false,
  quotaCooldownSeconds: 900,
  errorCooldownSeconds: 30,
  quotaStatuses: [402, 429],
  authFailureStatuses: [401],
  retryStatuses: [401, 402, 408, 425, 429, 500, 502, 503, 504],
  quotaBodyPatterns: ["rate limit"],
});

const pool = (overrides = {}) => ({
  id: "pool-a",
  slug: "provider-a",
  name: "Provider A",
  provider: "provider-a",
  accountIds: ["account-a"],
  strategy: "adaptive-sticky",
  settings: settings(),
  ...overrides,
});

const accounts = [
  { id: "account-a", provider: "provider-a" },
  { id: "account-b", provider: "provider-b" },
];

test("validates pools and returns defensive copies", () => {
  const input = [pool()];
  const result = validatePools(input, accounts);
  assert.deepEqual(result, input);
  assert.notEqual(result[0], input[0]);
  assert.notEqual(result[0].settings.quotaStatuses, input[0].settings.quotaStatuses);
  result[0].settings.quotaStatuses.push(418);
  assert.deepEqual(input[0].settings.quotaStatuses, [402, 429]);
});

test("rejects duplicate identifiers and unsafe or invalid names and slugs", () => {
  assert.throws(
    () => validatePools([pool(), pool({ slug: "provider-b" })], accounts),
    (error) => error instanceof PoolSchemaError && error.issues.some((issue) => issue.includes("duplicates another pool ID")),
  );
  assert.throws(
    () => validatePools([pool(), pool({ id: "pool-b" })], accounts),
    (error) => error instanceof PoolSchemaError && error.issues.some((issue) => issue.includes("duplicates another pool slug")),
  );
  for (const slug of ["", "../admin", "a/b", "A", "-bad"]) {
    assert.throws(() => validatePools([pool({ slug })], accounts), PoolSchemaError);
  }
  for (const name of ["", "  ", "../admin", "bad/name", "bad\\name", " leading"]) {
    assert.throws(() => validatePools([pool({ name })], accounts), PoolSchemaError);
  }
});

test("rejects unknown, cross-provider, duplicate, and multiply assigned accounts", () => {
  assert.throws(() => validatePools([pool({ accountIds: ["missing"] })], accounts), /unknown account/);
  assert.throws(() => validatePools([pool({ accountIds: ["account-b"] })], accounts), /another provider/);
  assert.throws(() => validatePools([pool({ accountIds: ["account-a", "account-a"] })], accounts), /duplicates/);
  assert.throws(
    () => validatePools([pool(), pool({ id: "pool-b", slug: "provider-b", name: "Provider B", accountIds: ["account-a"] })], accounts),
    /only one pool/,
  );
});

test("checks strategy and bounded settings", () => {
  assert.throws(() => validatePools([pool({ strategy: "first" })], accounts), /strategy is not supported/);
  assert.throws(() => validatePools([pool({ futureField: true })], accounts), /not a supported field/);
  assert.throws(
    () => validatePools([pool({ settings: { ...settings(), requestTimeoutMs: 600_001 } })], accounts),
    /requestTimeoutMs must be an integer/,
  );
  assert.throws(
    () => validatePools([pool({ settings: { ...settings(), upstreamUrl: "https://user:secret@provider.example/mcp" } })], accounts),
    /without embedded credentials/,
  );
  assert.throws(
    () => validatePools([pool({ settings: { ...settings(), quotaStatuses: [429, 429] } })], accounts),
    /unique HTTP status integers/,
  );
});

test("rejects unqualified tool names shared by different providers", () => {
  const pools = [
    { id: "pool-a", provider: "provider-a" },
    { id: "pool-b", provider: "provider-b" },
  ];
  assert.deepEqual(
    validateToolSets(pools, [
      { poolId: "pool-a", provider: "provider-a", toolNames: ["search"] },
      { poolId: "pool-b", provider: "provider-b", toolNames: ["lookup"] },
    ]).length,
    2,
  );
  assert.throws(
    () => validateToolSets(pools, [
      { poolId: "pool-a", provider: "provider-a", toolNames: ["search"] },
      { poolId: "pool-b", provider: "provider-b", toolNames: ["search"] },
    ]),
    /shared across providers/,
  );
  assert.throws(
    () => validateToolSets(pools, [{ poolId: "pool-a", provider: "provider-b", toolNames: [] }]),
    /does not match its pool/,
  );
  assert.throws(
    () => validateToolSets(pools, [{ poolId: "pool-a", provider: "provider-a", toolNames: Array(1001).fill("tool") }]),
    /exceeds the limit/,
  );
});

const legacyState = (legacyAccounts = []) => ({
  version: 1,
  config: {
    ...settings(),
    strategy: "round-robin",
    basePath: "/token2oauth",
    publicBaseUrl: "https://gateway.example/token2oauth",
  },
  accounts: legacyAccounts,
});

test("migrates a legacy single-provider state deterministically without mutation", () => {
  const state = legacyState([
    { id: "z-account", provider: "provider-a" },
    { id: "a-account", provider: "provider-a" },
  ]);
  const before = structuredClone(state);
  const first = migrateLegacyPool(state);
  const second = migrateLegacyPool(state);
  assert.deepEqual(first, second);
  assert.equal(first.id, "legacy-default");
  assert.equal(first.slug, "default");
  assert.equal(first.provider, "provider-a");
  assert.deepEqual(first.accountIds, ["a-account", "z-account"]);
  assert.equal(first.strategy, "round-robin");
  assert.deepEqual(state, before);
});

test("uses the existing generic provider for an empty legacy store and rejects mixed providers", () => {
  assert.equal(migrateLegacyPool(legacyState()).provider, "generic-bearer-mcp");
  assert.throws(
    () => migrateLegacyPool(legacyState([
      { id: "account-a", provider: "provider-a" },
      { id: "account-b", provider: "provider-b" },
    ])),
    /span providers/,
  );
});
