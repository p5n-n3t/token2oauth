/**
 * Pure normalization and bounded aggregation for telemetry supplied by a
 * caller. This module deliberately does not inspect requests or perform I/O.
 */

export interface LightSprintSessionInput {
  status?: unknown;
  stageLabel?: unknown;
  costUsd?: unknown;
  budgetUsd?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
  finishedAt?: unknown;
}

export interface UsageEventInput {
  timestamp?: unknown;
  source?: unknown;
  success?: unknown;
  status?: unknown;
  latencyMs?: unknown;
  pool?: unknown;
  provider?: unknown;
  account?: unknown;
  tool?: unknown;
  model?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheTokens?: unknown;
  costUsd?: unknown;
  quotaUsed?: unknown;
  quotaLimit?: unknown;
  session?: LightSprintSessionInput;
}

export interface NormalizedUsageEvent {
  timestamp: number | null;
  source: string | null;
  success: boolean | null;
  status: number | null;
  latencyMs: number | null;
  dimensions: UsageDimensions;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  costUsd: number | null;
  quota: {
    used: number | null;
    limit: number | null;
    usedFraction: number | null;
  };
  session: NormalizedLightSprintSession | null;
}

export interface UsageDimensions {
  pool: string | null;
  provider: string | null;
  account: string | null;
  tool: string | null;
  model: string | null;
}

export interface NormalizedLightSprintSession {
  status: string | null;
  stage: string | null;
  costUsd: number | null;
  budgetUsd: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
}

export interface UsageMetricsOptions {
  /** Maximum retained latency observations for the overall summary. */
  maxSamples?: number;
  /** Maximum dimension groups; additional combinations share an overflow group. */
  maxGroups?: number;
  /** Maximum retained latency observations for each dimension group. */
  maxGroupSamples?: number;
}

export interface UsageSummary {
  requests: number;
  successes: number;
  errors: number;
  unknownOutcomes: number;
  latency: {
    observed: number;
    sampled: number;
    sampleLimit: number;
    p50Ms: number | null;
    p95Ms: number | null;
  };
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  costUsd: number | null;
  quota: {
    observed: number;
    meanObservedUsedFraction: number | null;
  };
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sources: Record<string, number>;
}

export interface UsageGroup {
  dimensions: UsageDimensions;
  overflow: boolean;
  summary: UsageSummary;
}

export interface UsageMetricsSnapshot {
  summary: UsageSummary;
  groups: UsageGroup[];
}

const DEFAULT_MAX_SAMPLES = 2_048;
const DEFAULT_MAX_GROUPS = 100;
const DEFAULT_MAX_GROUP_SAMPLES = 128;
const MAX_SAMPLES = 20_000;
const MAX_GROUPS = 500;
const MAX_GROUP_SAMPLES = 2_000;
const MAX_LABEL_LENGTH = 80;
const OTHER_SOURCE = "(other)";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function tokenCount(value: unknown): number | null {
  const count = finiteNonNegative(value);
  return count !== null && Number.isInteger(count) ? count : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Keep low-risk categorical labels only. Callers should still use aliases
 * rather than personal names or account identifiers. Secret-like, URL, email,
 * and control-character values are discarded instead of being logged.
 */
export function privacySafeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.normalize("NFKC").trim();
  if (
    label.length === 0 ||
    label.length > MAX_LABEL_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(label) ||
    /(?:https?:\/\/|www\.|\bBearer\b|\b(?:token|secret|password|authorization|cookie|api[_ -]?key)\b)/iu.test(label) ||
    /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/u.test(label)
  ) {
    return null;
  }

  // Allow ordinary category names while excluding paths, query strings and
  // other free-form text that could carry request or identity data.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} ._-]*$/u.test(label)) return null;
  return label;
}

function normalizeSession(value: unknown): NormalizedLightSprintSession | null {
  if (!isRecord(value)) return null;
  const session: NormalizedLightSprintSession = {
    status: privacySafeLabel(value.status),
    stage: privacySafeLabel(value.stageLabel),
    costUsd: finiteNonNegative(value.costUsd),
    budgetUsd: finiteNonNegative(value.budgetUsd),
    createdAt: timestamp(value.createdAt),
    updatedAt: timestamp(value.updatedAt),
    finishedAt: timestamp(value.finishedAt),
  };
  return Object.values(session).some((field) => field !== null) ? session : null;
}

/** Normalize a telemetry-shaped input without retaining unknown fields. */
export function normalizeUsageEvent(input: unknown): NormalizedUsageEvent {
  const value = isRecord(input) ? input : {};
  const status =
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 100 &&
    value.status <= 599
      ? value.status
      : null;
  const explicitSuccess = typeof value.success === "boolean" ? value.success : null;
  const used = finiteNonNegative(value.quotaUsed);
  const limit = finiteNonNegative(value.quotaLimit);
  const session = normalizeSession(value.session);

  return {
    timestamp: timestamp(value.timestamp),
    source: privacySafeLabel(value.source),
    success: explicitSuccess ?? (status === null ? null : status >= 200 && status < 300),
    status,
    latencyMs: finiteNonNegative(value.latencyMs),
    dimensions: {
      pool: privacySafeLabel(value.pool),
      provider: privacySafeLabel(value.provider),
      account: privacySafeLabel(value.account),
      tool: privacySafeLabel(value.tool),
      model: privacySafeLabel(value.model),
    },
    inputTokens: tokenCount(value.inputTokens),
    outputTokens: tokenCount(value.outputTokens),
    cacheTokens: tokenCount(value.cacheTokens),
    costUsd: finiteNonNegative(value.costUsd),
    quota: {
      used,
      limit,
      usedFraction: used !== null && limit !== null && limit > 0 ? used / limit : null,
    },
    session,
  };
}

interface MutableSummary {
  requests: number;
  successes: number;
  errors: number;
  unknownOutcomes: number;
  latencyObserved: number;
  latencySamples: number[];
  latencyRandomState: number;
  inputTokens: number;
  inputTokensObserved: boolean;
  outputTokens: number;
  outputTokensObserved: boolean;
  cacheTokens: number;
  cacheTokensObserved: boolean;
  costUsd: number;
  costObserved: boolean;
  quotaObserved: number;
  quotaFractionSum: number;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
  sources: Map<string, number>;
  sourceOverflow: number;
}

function newMutableSummary(): MutableSummary {
  return {
    requests: 0,
    successes: 0,
    errors: 0,
    unknownOutcomes: 0,
    latencyObserved: 0,
    latencySamples: [],
    latencyRandomState: 0x6d2b79f5,
    inputTokens: 0,
    inputTokensObserved: false,
    outputTokens: 0,
    outputTokensObserved: false,
    cacheTokens: 0,
    cacheTokensObserved: false,
    costUsd: 0,
    costObserved: false,
    quotaObserved: 0,
    quotaFractionSum: 0,
    firstTimestamp: null,
    lastTimestamp: null,
    sources: new Map(),
    sourceOverflow: 0,
  };
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function recordSource(summary: MutableSummary, source: string | null): void {
  if (source === null) return;
  const known = summary.sources.get(source);
  if (known !== undefined) {
    summary.sources.set(source, known + 1);
  } else if (summary.sources.size < DEFAULT_MAX_GROUPS) {
    summary.sources.set(source, 1);
  } else {
    summary.sourceOverflow++;
  }
}

function recordLatency(summary: MutableSummary, latencyMs: number, sampleLimit: number): void {
  summary.latencyObserved++;
  const samples = summary.latencySamples;
  if (samples.length < sampleLimit) {
    samples.push(latencyMs);
    return;
  }

  // Deterministic reservoir sampling keeps memory fixed and results repeatable.
  let state = summary.latencyRandomState;
  state ^= state << 13;
  state ^= state >>> 17;
  state ^= state << 5;
  summary.latencyRandomState = state >>> 0;
  const position = Math.floor((summary.latencyRandomState / 0x1_0000_0000) * summary.latencyObserved);
  if (position < sampleLimit) samples[position] = latencyMs;
}

function addOptionalTotal(
  summary: MutableSummary,
  field: "inputTokens" | "outputTokens" | "cacheTokens" | "costUsd",
  value: number | null,
): void {
  if (value === null) return;
  summary[field] += value;
  if (field === "inputTokens") summary.inputTokensObserved = true;
  else if (field === "outputTokens") summary.outputTokensObserved = true;
  else if (field === "cacheTokens") summary.cacheTokensObserved = true;
  else summary.costObserved = true;
}

function recordEvent(
  summary: MutableSummary,
  event: NormalizedUsageEvent,
  sampleLimit: number,
): void {
  summary.requests++;
  if (event.success === true) summary.successes++;
  else if (event.success === false) summary.errors++;
  else summary.unknownOutcomes++;

  if (event.latencyMs !== null) recordLatency(summary, event.latencyMs, sampleLimit);
  addOptionalTotal(summary, "inputTokens", event.inputTokens);
  addOptionalTotal(summary, "outputTokens", event.outputTokens);
  addOptionalTotal(summary, "cacheTokens", event.cacheTokens);
  addOptionalTotal(summary, "costUsd", event.costUsd);

  if (event.quota.usedFraction !== null) {
    summary.quotaObserved++;
    summary.quotaFractionSum += event.quota.usedFraction;
  }
  if (event.timestamp !== null) {
    summary.firstTimestamp = summary.firstTimestamp === null
      ? event.timestamp
      : Math.min(summary.firstTimestamp, event.timestamp);
    summary.lastTimestamp = summary.lastTimestamp === null
      ? event.timestamp
      : Math.max(summary.lastTimestamp, event.timestamp);
  }
  recordSource(summary, event.source);
}

function percentile(samples: number[], fraction: number): number | null {
  if (samples.length === 0) return null;
  const ordered = [...samples].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)];
}

function snapshotSummary(
  value: MutableSummary,
  sampleLimit: number,
): UsageSummary {
  const sources = Object.fromEntries(value.sources);
  if (value.sourceOverflow > 0) sources[OTHER_SOURCE] = value.sourceOverflow;
  return {
    requests: value.requests,
    successes: value.successes,
    errors: value.errors,
    unknownOutcomes: value.unknownOutcomes,
    latency: {
      observed: value.latencyObserved,
      sampled: value.latencySamples.length,
      sampleLimit,
      p50Ms: percentile(value.latencySamples, 0.5),
      p95Ms: percentile(value.latencySamples, 0.95),
    },
    inputTokens: value.inputTokensObserved ? value.inputTokens : null,
    outputTokens: value.outputTokensObserved ? value.outputTokens : null,
    cacheTokens: value.cacheTokensObserved ? value.cacheTokens : null,
    costUsd: value.costObserved ? value.costUsd : null,
    quota: {
      observed: value.quotaObserved,
      meanObservedUsedFraction: value.quotaObserved > 0
        ? value.quotaFractionSum / value.quotaObserved
        : null,
    },
    firstTimestamp: value.firstTimestamp,
    lastTimestamp: value.lastTimestamp,
    sources,
  };
}

function dimensionKey(dimensions: UsageDimensions): string {
  return JSON.stringify([
    dimensions.pool,
    dimensions.provider,
    dimensions.account,
    dimensions.tool,
    dimensions.model,
  ]);
}

interface MutableGroup {
  dimensions: UsageDimensions;
  summary: MutableSummary;
}

/** Incremental accumulator with hard caps on groups and retained latency samples. */
export class UsageMetricsAccumulator {
  private readonly overall = newMutableSummary();
  private readonly groups = new Map<string, MutableGroup>();
  private readonly maxSamples: number;
  private readonly maxGroups: number;
  private readonly maxGroupSamples: number;

  constructor(options: UsageMetricsOptions = {}) {
    this.maxSamples = boundedOption(options.maxSamples, DEFAULT_MAX_SAMPLES, MAX_SAMPLES);
    this.maxGroups = boundedOption(options.maxGroups, DEFAULT_MAX_GROUPS, MAX_GROUPS);
    this.maxGroupSamples = boundedOption(
      options.maxGroupSamples,
      DEFAULT_MAX_GROUP_SAMPLES,
      MAX_GROUP_SAMPLES,
    );
  }

  record(input: unknown): NormalizedUsageEvent {
    const event = normalizeUsageEvent(input);
    recordEvent(this.overall, event, this.maxSamples);

    const dimensions = event.dimensions;
    let key = dimensionKey(dimensions);
    let group = this.groups.get(key);
    if (!group && this.groups.size >= this.maxGroups - 1) {
      key = "__overflow__";
      group = this.groups.get(key);
      if (!group) {
        group = {
          dimensions: { pool: null, provider: null, account: null, tool: null, model: null },
          summary: newMutableSummary(),
        };
        this.groups.set(key, group);
      }
    } else if (!group) {
      group = { dimensions, summary: newMutableSummary() };
      this.groups.set(key, group);
    }
    recordEvent(group.summary, event, this.maxGroupSamples);
    return event;
  }

  snapshot(): UsageMetricsSnapshot {
    const groups = [...this.groups.entries()]
      .map(([key, group]) => ({
        dimensions: { ...group.dimensions },
        overflow: key === "__overflow__",
        summary: snapshotSummary(group.summary, this.maxGroupSamples),
      }))
      .sort((a, b) => dimensionKey(a.dimensions).localeCompare(dimensionKey(b.dimensions)));
    return {
      summary: snapshotSummary(this.overall, this.maxSamples),
      groups,
    };
  }
}

/** Aggregate any iterable of events while retaining only bounded samples. */
export function aggregateUsage(
  events: Iterable<unknown>,
  options: UsageMetricsOptions = {},
): UsageMetricsSnapshot {
  const accumulator = new UsageMetricsAccumulator(options);
  for (const event of events) accumulator.record(event);
  return accumulator.snapshot();
}
