import { createHash } from "node:crypto";

/**
 * Provider capability snapshots.
 *
 * A snapshot records what one upstream MCP server exposed to one credential at
 * one point in time: the tool inventory (with per-tool schema hashes), where
 * and when it was fetched, and what is known about identity and quota. Values
 * Token2OAuth cannot observe are recorded as explicitly unknown rather than
 * guessed. Nothing in this module performs network I/O; callers supply a page
 * fetcher so tests and integrations stay free of live provider calls.
 */

/** A value that is either observed (with provenance) or explicitly unknown. */
export type Observed<T> =
  | { known: true; value: T; observedAt: number; source: string }
  | { known: false; reason: string };

export function unknown<T = never>(reason: string): Observed<T> {
  return { known: false, reason };
}

export function observed<T>(value: T, source: string, observedAt = Date.now()): Observed<T> {
  return { known: true, value, observedAt, source };
}

/** Minimal MCP tool shape as returned by tools/list. */
export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ToolsListPage {
  tools: McpTool[];
  nextCursor?: string;
}

export type ToolsListFetcher = (cursor: string | undefined) => Promise<ToolsListPage>;

export interface ToolRecord {
  name: string;
  title?: string;
  description?: string;
  /** sha256 of the canonical JSON of inputSchema (and outputSchema when present). */
  schemaHash: string;
  /** Page index (0-based) the tool was first seen on. */
  page: number;
  annotations?: Record<string, unknown>;
}

export interface ToolInventory {
  tools: ToolRecord[];
  /** Raw tool objects in first-seen order, for forwarding or re-filtering. */
  raw: McpTool[];
  pages: number;
  /** False when collection stopped early (page cap, cursor loop, error). */
  complete: boolean;
  incompleteReason?: string;
  /** Cursor that would have been requested next when incomplete. */
  nextCursor?: string;
  duplicateNames: string[];
  startedAt: number;
  finishedAt: number;
}

export interface CollectOptions {
  /** Hard cap on pages requested. Default 50. */
  maxPages?: number;
  /** Hard cap on tools retained. Default 5000. */
  maxTools?: number;
  now?: () => number;
}

export interface QuotaInfo {
  remaining?: number;
  limit?: number;
  unit?: string;
  resetsAt?: number;
}

export interface IdentityInfo {
  subject?: string;
  workspace?: string;
  team?: string;
}

export interface ProviderCapabilitySnapshot {
  /** Provider family, e.g. "lightsprint", "exa", "firecrawl" or a custom id. */
  provider: string;
  /** Pool account the snapshot was taken with; distinct from the provider. */
  accountId: string;
  accountLabel?: string;
  /** Upstream URL with credential-bearing query parameters redacted. */
  serverUrl: string;
  /** MCP serverInfo / protocol version when the caller observed initialize. */
  serverInfo: Observed<{ name?: string; version?: string; protocolVersion?: string }>;
  identity: Observed<IdentityInfo>;
  quota: Observed<QuotaInfo>;
  inventory: {
    fetchedAt: number;
    source: "tools/list";
    pages: number;
    complete: boolean;
    incompleteReason?: string;
    tools: ToolRecord[];
  };
  /** Hash over sorted tool names + schema hashes; equal hashes mean equal surfaces. */
  surfaceHash: string;
  capturedAt: number;
}

export interface SnapshotInput {
  provider: string;
  accountId: string;
  accountLabel?: string;
  serverUrl: string;
  inventory: ToolInventory;
  serverInfo?: ProviderCapabilitySnapshot["serverInfo"];
  identity?: Observed<IdentityInfo>;
  quota?: Observed<QuotaInfo>;
  now?: () => number;
}

/** JSON with object keys sorted recursively, so equal schemas hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function toolSchemaHash(tool: McpTool): string {
  return sha256(canonicalJson({ input: tool.inputSchema ?? null, output: tool.outputSchema ?? null }));
}

/**
 * Walks tools/list pagination. Stops on a missing/empty cursor, a repeated
 * cursor (loop), the page cap, the tool cap, or a fetch error; partial results
 * are returned with complete=false instead of throwing away what was seen.
 */
export async function collectToolInventory(
  fetchPage: ToolsListFetcher,
  options: CollectOptions = {},
): Promise<ToolInventory> {
  const now = options.now ?? Date.now;
  const maxPages = options.maxPages ?? 50;
  const maxTools = options.maxTools ?? 5000;
  const startedAt = now();
  const seenCursors = new Set<string>();
  const byName = new Map<string, ToolRecord>();
  const raw: McpTool[] = [];
  const duplicates = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  let complete = true;
  let incompleteReason: string | undefined;

  while (true) {
    if (pages >= maxPages) {
      complete = false;
      incompleteReason = `page cap of ${maxPages} reached`;
      break;
    }
    let page: ToolsListPage;
    try {
      page = await fetchPage(cursor);
    } catch (error) {
      complete = false;
      incompleteReason = `fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const pageIndex = pages;
    pages += 1;
    const tools = Array.isArray(page?.tools) ? page.tools : [];
    for (const tool of tools) {
      if (!tool || typeof tool.name !== "string" || tool.name.length === 0) continue;
      if (byName.has(tool.name)) {
        duplicates.add(tool.name);
        continue;
      }
      if (byName.size >= maxTools) {
        complete = false;
        incompleteReason = `tool cap of ${maxTools} reached`;
        break;
      }
      byName.set(tool.name, {
        name: tool.name,
        title: typeof tool.title === "string" ? tool.title : undefined,
        description: typeof tool.description === "string" ? tool.description : undefined,
        schemaHash: toolSchemaHash(tool),
        page: pageIndex,
        annotations: tool.annotations,
      });
      raw.push(tool);
    }
    if (!complete) break;
    const next = typeof page?.nextCursor === "string" && page.nextCursor.length > 0 ? page.nextCursor : undefined;
    if (!next) {
      cursor = undefined;
      break;
    }
    if (seenCursors.has(next) || next === cursor) {
      complete = false;
      incompleteReason = "cursor loop detected";
      cursor = next;
      break;
    }
    seenCursors.add(next);
    cursor = next;
  }

  return {
    tools: [...byName.values()],
    raw,
    pages,
    complete,
    incompleteReason,
    nextCursor: complete ? undefined : cursor,
    duplicateNames: [...duplicates],
    startedAt,
    finishedAt: now(),
  };
}

const SECRET_QUERY_KEYS = /^(?:.*api[-_]?key|.*token|.*secret|access[-_]?key|auth|authorization|key|password|signature|sig)$/i;

/**
 * Removes credentials from a URL before it is stored in a snapshot: userinfo
 * and query parameters whose names look like keys/tokens (e.g. Exa's legacy
 * `exaApiKey`). Path segments are kept; providers that embed keys in the path
 * should be configured with `pathSecretPattern`.
 */
export function redactUrl(input: string, pathSecretPattern?: RegExp): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return "[invalid-url]";
  }
  if (url.username || url.password) {
    url.username = "";
    url.password = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    if (SECRET_QUERY_KEYS.test(key)) url.searchParams.set(key, "REDACTED");
  }
  if (pathSecretPattern) {
    url.pathname = url.pathname
      .split("/")
      .map((segment) => (pathSecretPattern.test(segment) ? "REDACTED" : segment))
      .join("/");
  }
  return url.toString();
}

export function surfaceHash(tools: ToolRecord[]): string {
  const lines = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((t) => `${t.name}\u0000${t.schemaHash}`);
  return sha256(lines.join("\n"));
}

export function createCapabilitySnapshot(input: SnapshotInput): ProviderCapabilitySnapshot {
  if (!input.provider) throw new Error("provider is required");
  if (!input.accountId) throw new Error("accountId is required");
  const now = input.now ?? Date.now;
  return {
    provider: input.provider,
    accountId: input.accountId,
    accountLabel: input.accountLabel,
    serverUrl: redactUrl(input.serverUrl),
    serverInfo: input.serverInfo ?? unknown("initialize result not recorded"),
    identity: input.identity ?? unknown("provider exposes no identity endpoint to the gateway"),
    quota: input.quota ?? unknown("no documented quota endpoint; only reactive 402/429 signals"),
    inventory: {
      fetchedAt: input.inventory.finishedAt,
      source: "tools/list",
      pages: input.inventory.pages,
      complete: input.inventory.complete,
      incompleteReason: input.inventory.incompleteReason,
      tools: input.inventory.tools,
    },
    surfaceHash: surfaceHash(input.inventory.tools),
    capturedAt: now(),
  };
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  schemaChanged: string[];
  /** True when both snapshots are complete and the surfaces are identical. */
  identical: boolean;
  /** Set when either snapshot is incomplete, so "removed" may be a false positive. */
  partial: boolean;
}

export function diffSnapshots(before: ProviderCapabilitySnapshot, after: ProviderCapabilitySnapshot): SnapshotDiff {
  const a = new Map(before.inventory.tools.map((t) => [t.name, t]));
  const b = new Map(after.inventory.tools.map((t) => [t.name, t]));
  const added = [...b.keys()].filter((name) => !a.has(name)).sort();
  const removed = [...a.keys()].filter((name) => !b.has(name)).sort();
  const schemaChanged = [...b.keys()]
    .filter((name) => a.has(name) && a.get(name)!.schemaHash !== b.get(name)!.schemaHash)
    .sort();
  const partial = !before.inventory.complete || !after.inventory.complete;
  return {
    added,
    removed,
    schemaChanged,
    partial,
    identical: !partial && before.surfaceHash === after.surfaceHash,
  };
}

/**
 * Two credentials can share a pool only if they expose the same tool surface.
 * Pooling across differing surfaces lets a session see tools appear/disappear
 * when failover moves it to another account.
 */
export function surfacesCompatible(snapshots: ProviderCapabilitySnapshot[]): { compatible: boolean; reason?: string } {
  if (snapshots.length < 2) return { compatible: true };
  const providers = new Set(snapshots.map((s) => s.provider));
  if (providers.size > 1) return { compatible: false, reason: `mixed providers: ${[...providers].join(", ")}` };
  const incomplete = snapshots.find((s) => !s.inventory.complete);
  if (incomplete) return { compatible: false, reason: `inventory incomplete for account ${incomplete.accountId}` };
  const hashes = new Set(snapshots.map((s) => s.surfaceHash));
  if (hashes.size > 1) return { compatible: false, reason: "tool surfaces differ between accounts" };
  return { compatible: true };
}

// ---------------------------------------------------------------------------
// Documented provider profiles. These describe publicly documented behaviour
// as of 2026-10 and are static data: nothing here is fetched at runtime.
// ---------------------------------------------------------------------------

export interface AsyncToolPair {
  /** Tool that starts work and returns a job/run id. */
  start: string;
  /** Tool that reads or resumes the job, taking that id. */
  status: string;
  /** Argument on the status tool that carries the id. */
  idArgument: string;
}

export interface ProviderProfile {
  provider: string;
  docsUrl: string;
  defaultServerUrl: string;
  authModes: string[];
  /** Tool names documented publicly; the live tools/list is authoritative. */
  documentedTools: string[];
  /** Tools that exist only in specific clients (e.g. browser WebMCP). */
  clientOnlyTools?: string[];
  /** Work started by one credential that must be polled by the same credential. */
  asyncTools: AsyncToolPair[];
  /** Whether tool exposure itself is controlled by the provider URL. */
  toolSelection?: string;
  /** Always false here: none of these providers document a quota endpoint. */
  quotaEndpointDocumented: false;
  quotaSignals: string[];
  /** Scope a credential is bound to, which pooling must not cross. */
  credentialScope: string;
  notes: string[];
}

export const PROVIDER_PROFILES: Readonly<Record<string, ProviderProfile>> = Object.freeze({
  lightsprint: {
    provider: "lightsprint",
    docsUrl: "https://app.lightsprint.ai/docs/mcp/",
    defaultServerUrl: "https://app.lightsprint.ai/mcp",
    authModes: ["oauth", "bearer lsat_ access token"],
    documentedTools: ["lightsprint_api"],
    clientOnlyTools: ["lightsprint_current_page", "lightsprint_navigate"],
    asyncTools: [],
    quotaEndpointDocumented: false,
    quotaSignals: ["HTTP 402", "HTTP 429"],
    credentialScope: "workspace of the repository approved at authorization; other workspaces are refused",
    notes: [
      "A single tool, lightsprint_api({ method, path, body }), fronts every reachable endpoint.",
      "Disabling the tool disables the whole API; endpoint-level control needs method/path rules.",
      "Calls act as the authorizing user, with that user's workspace role, and can write.",
      "Agent sessions started through the API belong to the workspace/user that started them.",
    ],
  },
  exa: {
    provider: "exa",
    docsUrl: "https://exa.ai/docs/reference/exa-mcp",
    defaultServerUrl: "https://mcp.exa.ai/mcp",
    authModes: ["keyless (rate limited)", "oauth (?login)", "x-api-key header"],
    documentedTools: ["web_search_exa", "web_fetch_exa", "agent_run", "web_search_advanced_exa"],
    asyncTools: [{ start: "agent_run", status: "agent_run", idArgument: "runId" }],
    toolSelection: "?tools= comma list on the server URL replaces the default set",
    quotaEndpointDocumented: false,
    quotaSignals: ["HTTP 429", "agent_run result usage/cost fields"],
    credentialScope: "Exa team that owns the API key or OAuth grant",
    notes: [
      "agent_run returns status 'running' with an id; resume with runId on the same credential.",
      "previousRunId references a completed run and must use the owning credential.",
    ],
  },
  firecrawl: {
    provider: "firecrawl",
    docsUrl: "https://docs.firecrawl.dev/mcp-server",
    defaultServerUrl: "https://mcp.firecrawl.dev/v2/mcp",
    authModes: ["keyless (daily limits)", "oauth (/v2/mcp-oauth)", "bearer API key"],
    documentedTools: [
      "firecrawl_search",
      "firecrawl_scrape",
      "firecrawl_parse",
      "firecrawl_map",
      "firecrawl_find_tools",
      "firecrawl_crawl",
      "firecrawl_check_crawl_status",
      "firecrawl_agent",
      "firecrawl_agent_status",
      "firecrawl_interact",
      "firecrawl_interact_stop",
      "firecrawl_developer_search",
      "firecrawl_gov_search",
      "firecrawl_search_feedback",
      "firecrawl_feedback",
    ],
    asyncTools: [
      { start: "firecrawl_agent", status: "firecrawl_agent_status", idArgument: "id" },
      { start: "firecrawl_crawl", status: "firecrawl_check_crawl_status", idArgument: "id" },
    ],
    quotaEndpointDocumented: false,
    quotaSignals: ["HTTP 402", "HTTP 429"],
    credentialScope: "Firecrawl team that owns the API key or OAuth grant",
    notes: [
      "firecrawl_research_* and firecrawl_monitor_* are documented as families; read names from tools/list.",
      "Extract is deprecated and not part of the current tool surface.",
    ],
  },
});

export function providerProfile(provider: string): ProviderProfile | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PROFILES, provider) ? PROVIDER_PROFILES[provider] : undefined;
}

/** True when a tools/call starts or polls credential-owned async work. */
export function asyncToolRole(provider: string, toolName: string): "start" | "status" | "both" | undefined {
  const profile = providerProfile(provider);
  if (!profile) return undefined;
  let start = false;
  let status = false;
  for (const pair of profile.asyncTools) {
    if (pair.start === toolName) start = true;
    if (pair.status === toolName) status = true;
  }
  if (start && status) return "both";
  if (start) return "start";
  if (status) return "status";
  return undefined;
}
