import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateUsage,
  normalizeUsageEvent,
  privacySafeLabel,
  UsageMetricsAccumulator,
} from "../dist/usage-metrics.js";

test("normalizes request dimensions, optional usage, source, and timestamps", () => {
  const event = normalizeUsageEvent({
    timestamp: "2026-01-02T03:04:05.000Z",
    source: "telemetry-pr3",
    status: 201,
    latencyMs: 12.5,
    pool: "primary",
    provider: "example-provider",
    account: "account-a",
    tool: "search",
    model: "model-v2",
    inputTokens: 12,
    outputTokens: 3,
    cacheTokens: 4,
    costUsd: 0.002,
    quotaUsed: 25,
    quotaLimit: 100,
    payload: { body: "must not be retained" },
  });

  assert.equal(event.timestamp, Date.parse("2026-01-02T03:04:05.000Z"));
  assert.equal(event.source, "telemetry-pr3");
  assert.equal(event.success, true);
  assert.deepEqual(event.dimensions, {
    pool: "primary",
    provider: "example-provider",
    account: "account-a",
    tool: "search",
    model: "model-v2",
  });
  assert.equal(event.inputTokens, 12);
  assert.equal(event.outputTokens, 3);
  assert.equal(event.cacheTokens, 4);
  assert.equal(event.costUsd, 0.002);
  assert.deepEqual(event.quota, { used: 25, limit: 100, usedFraction: 0.25 });
  assert.equal("payload" in event, false);
});

test("keeps quota unknown unless actual usage and a positive limit are supplied", () => {
  for (const input of [
    {},
    { quotaUsed: 50 },
    { quotaLimit: 100 },
    { quotaUsed: 50, quotaLimit: 0 },
    { quotaUsed: -1, quotaLimit: 100 },
  ]) {
    assert.equal(normalizeUsageEvent(input).quota.usedFraction, null);
  }
  assert.equal(normalizeUsageEvent({ quotaUsed: 150, quotaLimit: 100 }).quota.usedFraction, 1.5);
});

test("normalizes LightSprint session accounting separately from account quota", () => {
  const event = normalizeUsageEvent({
    costUsd: 0.1,
    session: {
      status: "running",
      stageLabel: "Working",
      costUsd: 1.25,
      budgetUsd: 5,
      createdAt: "2026-04-05T00:00:00Z",
      updatedAt: 1_775_000_000_000,
    },
  });

  assert.deepEqual(event.session, {
    status: "running",
    stage: "Working",
    costUsd: 1.25,
    budgetUsd: 5,
    createdAt: Date.parse("2026-04-05T00:00:00Z"),
    updatedAt: 1_775_000_000_000,
    finishedAt: null,
  });
  assert.equal(event.quota.used, null);
  assert.equal(event.quota.limit, null);
  assert.equal(event.quota.usedFraction, null);
  assert.equal(event.costUsd, 0.1);
});

test("aggregates outcomes, nearest-rank latency percentiles, optional totals, and provenance", () => {
  const summary = aggregateUsage([
    { timestamp: 30, source: "proxy", status: 200, latencyMs: 30, inputTokens: 0, quotaUsed: 1, quotaLimit: 4 },
    { timestamp: 10, source: "proxy", status: 503, latencyMs: 10, outputTokens: 7, quotaUsed: 3, quotaLimit: 2 },
    { timestamp: 20, source: "probe", success: null, latencyMs: 20, costUsd: 0.5 },
    { timestamp: 40, source: "probe", success: false, latencyMs: 40, costUsd: 0.25 },
  ]).summary;

  assert.equal(summary.requests, 4);
  assert.equal(summary.successes, 1);
  assert.equal(summary.errors, 2);
  assert.equal(summary.unknownOutcomes, 1);
  assert.deepEqual(summary.latency, {
    observed: 4,
    sampled: 4,
    sampleLimit: 2_048,
    p50Ms: 20,
    p95Ms: 40,
  });
  assert.equal(summary.inputTokens, 0);
  assert.equal(summary.outputTokens, 7);
  assert.equal(summary.cacheTokens, null);
  assert.equal(summary.costUsd, 0.75);
  assert.equal(summary.quota.observed, 2);
  assert.equal(summary.quota.meanObservedUsedFraction, 0.875);
  assert.equal(summary.firstTimestamp, 10);
  assert.equal(summary.lastTimestamp, 40);
  assert.deepEqual(summary.sources, { proxy: 2, probe: 2 });
});

test("bounds retained samples and groups and produces repeatable reservoir percentiles", () => {
  const inputs = Array.from({ length: 20 }, (_, index) => ({
    latencyMs: index + 1,
    provider: `provider-${index}`,
  }));
  const options = { maxSamples: 3, maxGroupSamples: 2, maxGroups: 2 };
  const first = aggregateUsage(inputs, options);
  const second = aggregateUsage(inputs, options);

  assert.equal(first.summary.latency.observed, 20);
  assert.equal(first.summary.latency.sampled, 3);
  assert.equal(first.groups.length, 2);
  assert.equal(first.groups.filter((group) => group.overflow).length, 1);
  assert.equal(first.groups.find((group) => group.overflow).summary.requests, 19);
  assert.deepEqual(first, second);
});

test("sanitizes secret-like, identifying, and free-form labels and rejects invalid metrics", () => {
  assert.equal(privacySafeLabel("example-provider"), "example-provider");
  assert.equal(privacySafeLabel("person@example.com"), null);
  assert.equal(privacySafeLabel("https://service.example/path"), null);
  assert.equal(privacySafeLabel("Bearer abc.def"), null);
  assert.equal(privacySafeLabel("customer secret"), null);

  const event = normalizeUsageEvent({
    provider: "Bearer private-token",
    tool: "lookup?query=private",
    latencyMs: -1,
    inputTokens: 2.5,
    outputTokens: Infinity,
    costUsd: "0.25",
    status: 700,
    timestamp: "not a date",
  });
  assert.equal(event.dimensions.provider, null);
  assert.equal(event.dimensions.tool, null);
  assert.equal(event.latencyMs, null);
  assert.equal(event.inputTokens, null);
  assert.equal(event.outputTokens, null);
  assert.equal(event.costUsd, null);
  assert.equal(event.status, null);
  assert.equal(event.success, null);
  assert.equal(event.timestamp, null);
});

test("incremental accumulator returns normalized records and snapshots without exposing mutable state", () => {
  const accumulator = new UsageMetricsAccumulator({ maxSamples: 2 });
  const normalized = accumulator.record({ status: 204, provider: "provider-a" });
  const snapshot = accumulator.snapshot();
  snapshot.groups[0].dimensions.provider = "changed";

  assert.equal(normalized.success, true);
  assert.equal(accumulator.snapshot().groups[0].dimensions.provider, "provider-a");
});
