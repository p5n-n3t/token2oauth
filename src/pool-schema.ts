import type { GatewayConfig, PersistedState, PoolStrategy, UpstreamAccount } from "./types.js";

const POOL_STRATEGIES: readonly PoolStrategy[] = [
  "adaptive-sticky", "round-robin", "least-used", "weighted-random", "random", "priority",
];
const MAX_POOLS = 1_000;
const MAX_ACCOUNTS = 10_000;
const MAX_TOOL_SETS = 1_000;
const MAX_TOOLS_PER_SET = 1_000;
const SETTINGS_KEYS = [
  "upstreamUrl", "upstreamAuthHeader", "upstreamAuthScheme", "requestTimeoutMs",
  "maxFailoverAttempts", "failoverStateful", "quotaCooldownSeconds",
  "errorCooldownSeconds", "quotaStatuses", "authFailureStatuses", "retryStatuses",
  "quotaBodyPatterns",
] as const;

export type PoolSettings = Pick<GatewayConfig, (typeof SETTINGS_KEYS)[number]>;

/** A future named routing boundary. The current runtime still uses one global config. */
export interface PoolDefinition {
  /** Caller-supplied stable identifier; validation never generates or rewrites it. */
  id: string;
  /** Lowercase URL segment used by a future pools/<slug>/mcp route. */
  slug: string;
  name: string;
  /** Must exactly match the provider identity on every member account. */
  provider: string;
  accountIds: string[];
  strategy: PoolStrategy;
  settings: PoolSettings;
}

export interface PoolToolSet {
  poolId: string;
  provider: string;
  toolNames: string[];
}

export class PoolSchemaError extends Error {
  constructor(readonly issues: readonly string[]) {
    super("invalid pool schema: " + issues.join("; "));
    this.name = "PoolSchemaError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLabel(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 80 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f/\\]/.test(value) &&
    value !== "." &&
    value !== ".."
  );
}

function validHeaderName(value: unknown): value is string {
  return typeof value === "string" && /^[!#$%&'*+.^_|~0-9A-Za-z-]{1,128}$/.test(value);
}

function validText(value: unknown, maxLength = 256): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function validateSettings(value: unknown, path: string, issues: string[]): PoolSettings | undefined {
  if (!isRecord(value)) {
    issues.push(path + " must be an object");
    return undefined;
  }
  for (const key of Object.keys(value)) {
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      issues.push(path + "." + key + " is not a supported setting");
    }
  }
  for (const key of SETTINGS_KEYS) {
    if (!(key in value)) issues.push(path + "." + key + " is required");
  }

  const upstreamUrl = value.upstreamUrl;
  if (typeof upstreamUrl !== "string" || upstreamUrl.length > 2048) {
    issues.push(path + ".upstreamUrl must be a string of at most 2048 characters");
  } else if (upstreamUrl !== "") {
    try {
      const parsed = new URL(upstreamUrl);
      if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
        issues.push(path + ".upstreamUrl must be an HTTP(S) URL without embedded credentials");
      }
    } catch {
      issues.push(path + ".upstreamUrl must be an absolute HTTP(S) URL");
    }
  }
  if (!validHeaderName(value.upstreamAuthHeader)) {
    issues.push(path + ".upstreamAuthHeader must be a valid HTTP header name");
  }
  if (!validText(value.upstreamAuthScheme, 64)) {
    issues.push(path + ".upstreamAuthScheme must be non-empty text of at most 64 characters");
  }
  if (typeof value.requestTimeoutMs !== "number" || !Number.isInteger(value.requestTimeoutMs) || value.requestTimeoutMs < 1 || value.requestTimeoutMs > 600_000) {
    issues.push(path + ".requestTimeoutMs must be an integer from 1 to 600000");
  }
  if (typeof value.maxFailoverAttempts !== "number" || !Number.isInteger(value.maxFailoverAttempts) || value.maxFailoverAttempts < 1 || value.maxFailoverAttempts > 20) {
    issues.push(path + ".maxFailoverAttempts must be an integer from 1 to 20");
  }
  if (typeof value.failoverStateful !== "boolean") {
    issues.push(path + ".failoverStateful must be a boolean");
  }
  for (const key of ["quotaCooldownSeconds", "errorCooldownSeconds"] as const) {
    const seconds = value[key];
    if (typeof seconds !== "number" || !Number.isInteger(seconds) || seconds < 0 || seconds > 86_400) {
      issues.push(path + "." + key + " must be an integer from 0 to 86400");
    }
  }
  for (const key of ["quotaStatuses", "authFailureStatuses", "retryStatuses"] as const) {
    const statuses = value[key];
    if (
      !Array.isArray(statuses) ||
      statuses.length > 100 ||
      statuses.some((status) => typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) ||
      new Set(statuses).size !== statuses.length
    ) {
      issues.push(path + "." + key + " must contain unique HTTP status integers from 100 to 599");
    }
  }
  const patterns = value.quotaBodyPatterns;
  if (
    !Array.isArray(patterns) ||
    patterns.length > 50 ||
    patterns.some((pattern) => typeof pattern !== "string" || pattern.length > 256)
  ) {
    issues.push(path + ".quotaBodyPatterns must contain at most 50 strings of at most 256 characters");
  } else {
    patterns.forEach((pattern, index) => {
      try {
        new RegExp(pattern, "i");
      } catch {
        issues.push(path + ".quotaBodyPatterns[" + index + "] must be a valid regular expression");
      }
    });
  }

  if (issues.some((issue) => issue.startsWith(path + ".") || issue === path + " must be an object")) {
    return undefined;
  }
  return Object.fromEntries(SETTINGS_KEYS.map((key) => {
    const item = value[key];
    return [key, Array.isArray(item) ? [...item] : item];
  })) as unknown as PoolSettings;
}

/** Validate and defensively copy pool definitions against the existing flat account list. */
export function validatePools(
  input: unknown,
  accounts: readonly Pick<UpstreamAccount, "id" | "provider">[],
): PoolDefinition[] {
  const issues: string[] = [];
  if (!Array.isArray(input)) throw new PoolSchemaError(["pools must be an array"]);
  if (input.length > MAX_POOLS) throw new PoolSchemaError(["pools exceeds the limit of 1000"]);
  if (accounts.length > MAX_ACCOUNTS) throw new PoolSchemaError(["accounts exceeds the limit of 10000"]);
  const knownAccounts = new Map<string, string>();
  for (const account of accounts) {
    if (!validText(account.id, 128)) issues.push("account IDs must be non-empty text of at most 128 characters");
    if (!validText(account.provider, 80)) issues.push("account provider identities must be non-empty text of at most 80 characters");
    if (knownAccounts.has(account.id)) issues.push("account IDs must be unique");
    knownAccounts.set(account.id, account.provider);
  }

  const ids = new Set<string>();
  const slugs = new Set<string>();
  const assignedAccounts = new Set<string>();
  const result: PoolDefinition[] = [];
  input.forEach((item, index) => {
    const path = "pools[" + index + "]";
    if (!isRecord(item)) {
      issues.push(path + " must be an object");
      return;
    }
    for (const key of Object.keys(item)) {
      if (!["id", "slug", "name", "provider", "accountIds", "strategy", "settings"].includes(key)) {
        issues.push(path + "." + key + " is not a supported field");
      }
    }
    const { id, slug, name, provider, accountIds, strategy } = item;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
      issues.push(path + ".id must be a stable identifier of 1 to 64 letters, digits, underscores, or hyphens");
    } else if (ids.has(id)) {
      issues.push(path + ".id duplicates another pool ID");
    } else ids.add(id);
    if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 63) {
      issues.push(path + ".slug must be a lowercase URL-safe slug");
    } else if (slugs.has(slug)) {
      issues.push(path + ".slug duplicates another pool slug");
    } else slugs.add(slug);
    if (!validLabel(name)) issues.push(path + ".name must be non-empty, trimmed text without controls or path separators");
    if (!validText(provider, 80)) issues.push(path + ".provider must be non-empty text of at most 80 characters");
    if (!Array.isArray(accountIds) || accountIds.some((accountId) => typeof accountId !== "string")) {
      issues.push(path + ".accountIds must be an array of account IDs");
    } else {
      const memberIds = new Set<string>();
      for (const accountId of accountIds as string[]) {
        if (memberIds.has(accountId)) issues.push(path + ".accountIds must not contain duplicates");
        memberIds.add(accountId);
        if (!knownAccounts.has(accountId)) issues.push(path + ".accountIds contains an unknown account");
        else if (knownAccounts.get(accountId) !== provider) issues.push(path + ".accountIds contains an account from another provider");
        if (assignedAccounts.has(accountId)) issues.push("an account may belong to only one pool");
        assignedAccounts.add(accountId);
      }
    }
    if (typeof strategy !== "string" || !POOL_STRATEGIES.includes(strategy as PoolStrategy)) {
      issues.push(path + ".strategy is not supported");
    }
    const settings = validateSettings(item.settings, path + ".settings", issues);
    if (
      typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) &&
      typeof slug === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && slug.length <= 63 &&
      validLabel(name) && validText(provider, 80) && Array.isArray(accountIds) &&
      accountIds.every((accountId) => typeof accountId === "string") &&
      typeof strategy === "string" && POOL_STRATEGIES.includes(strategy as PoolStrategy) && settings
    ) {
      result.push({
        id, slug, name, provider, accountIds: [...accountIds] as string[],
        strategy: strategy as PoolStrategy, settings,
      });
    }
  });
  if (issues.length) throw new PoolSchemaError(issues);
  return result;
}

/** Reject an aggregate MCP tool catalog whose unqualified names map to multiple providers. */
export function validateToolSets(
  pools: readonly Pick<PoolDefinition, "id" | "provider">[],
  toolSets: readonly PoolToolSet[],
): PoolToolSet[] {
  const issues: string[] = [];
  if (toolSets.length > MAX_TOOL_SETS) {
    throw new PoolSchemaError(["toolSets exceeds the limit of 1000"]);
  }
  const poolById = new Map(pools.map((pool) => [pool.id, pool.provider]));
  const providersByTool = new Map<string, string>();
  const copied: PoolToolSet[] = [];
  for (const [index, toolSet] of toolSets.entries()) {
    if (toolSet.toolNames.length > MAX_TOOLS_PER_SET) {
      issues.push("toolSets[" + index + "].toolNames exceeds the limit of 1000");
      continue;
    }
    const expectedProvider = poolById.get(toolSet.poolId);
    if (expectedProvider === undefined) issues.push("toolSets[" + index + "] references an unknown pool");
    else if (expectedProvider !== toolSet.provider) issues.push("toolSets[" + index + "] provider does not match its pool");
    if (!Array.isArray(toolSet.toolNames)) {
      issues.push("toolSets[" + index + "].toolNames must be an array");
      continue;
    }
    const localNames = new Set<string>();
    for (const toolName of toolSet.toolNames) {
      if (!validText(toolName, 128)) {
        issues.push("toolSets[" + index + "] contains an invalid tool name");
        continue;
      }
      if (localNames.has(toolName)) issues.push("toolSets[" + index + "] contains a duplicate tool name");
      localNames.add(toolName);
      const previousProvider = providersByTool.get(toolName);
      if (previousProvider !== undefined && previousProvider !== toolSet.provider) {
        issues.push("unqualified tool names must not be shared across providers");
      } else providersByTool.set(toolName, toolSet.provider);
    }
    copied.push({ poolId: toolSet.poolId, provider: toolSet.provider, toolNames: [...toolSet.toolNames] });
  }
  if (issues.length) throw new PoolSchemaError(issues);
  return copied;
}

/** Convert a v1 flat store to one deterministic pool without mutating or persisting the state. */
export function migrateLegacyPool(
  state: Pick<PersistedState, "config" | "accounts">,
): PoolDefinition {
  const providers = [...new Set(state.accounts.map((account) => account.provider))].sort();
  if (providers.length > 1) {
    throw new PoolSchemaError(["legacy accounts span providers and cannot form one unambiguous pool"]);
  }
  const config = state.config;
  const settings = Object.fromEntries(SETTINGS_KEYS.map((key) => [key, config[key]])) as PoolSettings;
  return validatePools([{
    id: "legacy-default",
    slug: "default",
    name: "Default",
    provider: providers[0] || "generic-bearer-mcp",
    accountIds: state.accounts.map((account) => account.id).sort(),
    strategy: config.strategy,
    settings,
  }], state.accounts)[0];
}
