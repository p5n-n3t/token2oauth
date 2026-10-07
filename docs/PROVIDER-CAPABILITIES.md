# Provider capabilities and tool policy

Status: **integrated in 0.2.0.**

- `config.toolPolicy` (optional; absent = passthrough) is enforced by the
  proxy before any upstream I/O: denied `tools/call` requests get a JSON-RPC
  `-32602` error and never reach the upstream; a batch containing one is
  rejected whole; non-JSON bodies are refused while a policy is active;
  `tools/list` responses (JSON or SSE) are filtered, failing closed with a 502
  if the response cannot be parsed.
- `src/capabilities.ts` collects a per-account inventory (`initialize`,
  `notifications/initialized`, paginated `tools/list`, then `DELETE` of the
  upstream session) and stores names, descriptions, schema hashes and
  annotation hints in `state.capabilities` (never tokens).
- Dashboard **Tools** page: per-account inventory, enable/disable toggles
  (written as `denyTools`; CLI-managed `allowTools`/`endpoints` are kept) and
  "replay-safe" marks (`config.readOnlyTools`).
- CLI: `token2oauth tools refresh|list|deny|allow|policy show|policy set`.

## Capability snapshots

A `ProviderCapabilitySnapshot` records what one upstream MCP server showed one
pool account at one moment:

| Field | Meaning |
| --- | --- |
| `provider` | Provider family (`lightsprint`, `exa`, `firecrawl`, or custom). |
| `accountId` / `accountLabel` | The pool credential used. Provider and account are separate: two accounts of one provider can see different tools. |
| `serverUrl` | Upstream URL with userinfo and key/token-like query parameters redacted (`redactUrl`). |
| `inventory` | Tools from `tools/list`: name, title, description, `schemaHash` (sha256 of canonical JSON of input/output schema), page index, plus `fetchedAt`, `pages`, `complete`, `incompleteReason`. |
| `surfaceHash` | Hash over sorted tool names and schema hashes. Equal hashes mean equal surfaces. |
| `serverInfo`, `identity`, `quota` | `Observed<T>`: either `{ known: true, value, observedAt, source }` or `{ known: false, reason }`. |
| `capturedAt` | When the snapshot was assembled. |

When nothing is observed, identity and quota default to **unknown**. None of
these providers documents a quota or usage endpoint, so the module never
invents a value. Quota is still detected reactively, as `docs/POOLING.md`
describes: 402, 429, `Retry-After` and body patterns.

### Paginated inventory

`collectToolInventory(fetchPage, { maxPages, maxTools })` follows MCP
`nextCursor` pagination. The caller supplies `fetchPage(cursor)`, so the module
does no network I/O. Collection stops with `complete: false`, keeping what it
already read, when any of these happens:

- the page cap is hit
- the tool cap is hit
- a cursor repeats (a loop)
- a fetch fails

Duplicate tool names are dropped after the first one and reported in
`duplicateNames`.

`diffSnapshots(a, b)` reports tools added, removed and with changed schemas. It
sets `partial` when either inventory is incomplete. `surfacesCompatible([...])`
refuses to call accounts poolable in three cases: they belong to different
providers, an inventory is incomplete, or their surfaces differ.

### Documented provider profiles (as of 2026-10)

`PROVIDER_PROFILES` is static data copied from public docs. At runtime the live
`tools/list` result is authoritative.

| Provider | Server | Tools | Async (credential-owned) work | Quota endpoint |
| --- | --- | --- | --- | --- |
| LightSprint ([docs](https://app.lightsprint.ai/docs/mcp/)) | `https://app.lightsprint.ai/mcp` | `lightsprint_api` only. Browser WebMCP adds `lightsprint_current_page` and `lightsprint_navigate`. | Agent sessions started through the API | None documented |
| Exa ([docs](https://exa.ai/docs/reference/exa-mcp)) | `https://mcp.exa.ai/mcp`, with `?tools=` selecting tools | `web_search_exa`, `web_fetch_exa`, `agent_run`, `web_search_advanced_exa` (opt-in) | `agent_run` returns an `id`; resume with `runId`. `previousRunId` references a run. | None documented. Completed runs report usage and cost. |
| Firecrawl ([docs](https://docs.firecrawl.dev/mcp-server/tools)) | `https://mcp.firecrawl.dev/v2/mcp` (bearer) or `/v2/mcp-oauth` | `firecrawl_search`, `_scrape`, `_parse`, `_map`, `_crawl`, `_check_crawl_status`, `_agent`, `_agent_status`, `_interact`, … plus the `firecrawl_research_*` and `firecrawl_monitor_*` families | `firecrawl_agent` → `firecrawl_agent_status`; `firecrawl_crawl` → `firecrawl_check_crawl_status` | None documented |

`asyncToolRole(provider, tool)` tells you whether a call starts or polls
credential-owned work.

## Tool policy engine

`ToolPolicy` is plain JSON. `compileToolPolicy` validates it and throws
`PolicyConfigError` on bad config. Every helper also accepts an uncompiled
policy or `undefined`.

~~~json
{
  "allowTools": ["lightsprint_api", "web_search_exa"],
  "denyTools": ["agent_run"],
  "hideDenied": true,
  "endpoints": [
    {
      "tool": "lightsprint_api",
      "prefix": "/api/",
      "bindings": { "workspaceId": "ws_123" },
      "rules": [
        { "id": "task-read",  "methods": ["GET"],   "path": "/api/tasks/{taskId}" },
        { "id": "task-edit",  "methods": ["PATCH"], "path": "/api/tasks/{taskId}" },
        { "id": "resolve",    "methods": ["GET"],   "path": "/api/workspaces/{workspaceId}/tasks/resolve", "query": ["ref"] }
      ]
    }
  ]
}
~~~

### Semantics

- **No policy means no change.** With `undefined`, `filterTools`,
  `gateClientMessage` and `filterServerMessage` return their input unchanged
  (the same object) and `evaluateToolCall` allows everything. `{}` behaves the
  same way. This keeps existing deployments backwards compatible.
- **Tool level.** `denyTools` always wins. If `allowTools` is set, every other
  tool is hidden from `tools/list` and rejected on `tools/call`. Names match
  exactly, with no case folding or trimming.
- **Single-API tools.** LightSprint exposes one tool,
  `lightsprint_api({ method, path, body })`. Turning that tool off (deny it, or
  leave it out of `allowTools`) **disables the entire API**. Endpoint rules are
  a separate, finer layer that only applies while the tool is allowed:
  - Without an `endpoints` entry for the tool, every method and path passes.
    This is tool-level control only.
  - With an entry, only matching `(method, path)` pairs pass.
  - An empty `rules` array denies every call and hides the tool.
- **Rules.**
  - `methods` lists exact upper-case HTTP verbs.
  - `path` segments are literals, `*` (exactly one segment) or `{name}` (one
    segment, pinned to `bindings[name]` when bound).
  - There is **no multi-segment wildcard**, and patterns must sit below the
    prefix, so no rule can turn the tool into a generic proxy.
  - The query string is denied unless `query` lists the allowed keys.
  - A body is denied for GET and DELETE unless `allowBody` says otherwise.
  - Any argument other than `method`, `path` and `body` is rejected.

### Path normalization (`normalizeApiPath`)

The engine rejects ambiguous paths instead of repairing them, so the raw path
forwarded upstream and the decoded path the policy checked cannot disagree. It
rejects:

- absolute or protocol-relative URLs (`https://…`, `//host`, `http:/…`)
- backslashes, raw or encoded (`%5c`)
- fragments (`#`)
- control characters (C0, DEL, C1, U+2028 and U+2029), raw or encoded (`%00`, `%0d%0a`)
- empty segments (`//`)
- dot segments, raw or encoded (`..`, `.%2e`, `%2E%2E`, `...`)
- encoded separators (`%2f`)
- anything still containing `%` after one decode (double encoding, `%252e`)
- malformed escapes
- any segment character outside `[A-Za-z0-9._~\-:@]`. This blocks `;` matrix
  parameters, spaces and non-ASCII lookalikes such as `．．`.

One trailing slash is tolerated and dropped. Matching is case-sensitive, so
`/API/…` fails the prefix check.

### JSON-RPC helpers

- `gateClientMessage(policy, payload)` takes one message or a batch. It returns
  `{ forward, rejections }`: `forward` holds what may go upstream (`null` if
  nothing is left), and each rejected `tools/call` request gets a JSON-RPC error
  (`-32602`, with `data.code` set to the denial code). A rejected notification
  is dropped.
- `filterServerMessage(policy, payload, requestMethods)` filters `result.tools`
  only in responses whose id maps to `tools/list`. Other fields such as
  `nextCursor` are kept, and the input is never mutated.

## Safe pooling requirements

Token2OAuth pools several credentials behind one OAuth client. These
invariants must hold before a provider or tool is pooled:

1. **Workspace/repo scoping.** A LightSprint token is bound to the workspace
   of the repository approved at authorization, and calls naming another
   workspace are refused upstream. Pool only credentials of the **same
   workspace and role**, and pin `{workspaceId}` with `bindings`. Otherwise
   failover silently changes which workspace a call reads or writes. Apply the
   same rule to Exa and Firecrawl teams: billing and data belong to the team.
2. **Surface equality.** Pool only accounts whose snapshots satisfy
   `surfacesCompatible`. If they don't, a session can watch tools appear or
   vanish after failover.
3. **MCP-session affinity.** A provider may tie `Mcp-Session-Id` to
   server-side state. Keep a session pinned to its credential, as
   `adaptive-sticky` does, and leave `failoverStateful` at `false` unless the
   provider documents stateless sessions.
4. **Async job ownership.** Exa `agent_run` ids and `previousRunId`, Firecrawl
   agent and crawl ids, and LightSprint agent sessions belong to the
   credential that created them. Calls that poll or resume (see
   `asyncToolRole`) must go to the **same account** that started the job. Keep
   a job-id → account map, and fail closed if the owner is unavailable rather
   than sending the id to another account.
5. **No mutation replay on ambiguous failure.** Retry on another credential
   only when the upstream verifiably did not process the request: connection
   refused, an auth failure before the request was read, or 429/402 that
   rejects up front. Never replay these after a timeout, reset or 5xx whose
   outcome is unknown:
   - a `tools/call` that may mutate: any non-GET `lightsprint_api` call, any
     async "start" tool, or a tool whose `annotations.readOnlyHint` is not
     `true`
   - any JSON-RPC batch containing such a call

   Return the error and let the client decide.
6. **Secrets.** Snapshots store redacted URLs only. Never log tool arguments
   that may carry provider keys.

## Integration steps

These steps are not done in this change.

1. Add an optional `toolPolicy?: ToolPolicy` to `GatewayConfig` (absent by
   default) and compile it once when the config loads.
2. In `proxy.ts`, parse JSON request bodies for POST `/mcp`, then call
   `gateClientMessage`:
   - If there are rejections and nothing to forward, answer locally.
   - If it is a mixed batch, forward the remainder and merge the rejections
     into the response.
3. Record request id → method for `tools/list`. Run `filterServerMessage` on
   JSON responses and on each SSE `data:` event before streaming it to the
   client.
4. Add a `token2oauth account snapshot [ACCOUNT_ID]` command that runs
   `initialize` and paginated `tools/list` per account through
   `collectToolInventory`, then stores `createCapabilitySnapshot` output.
   Use `surfacesCompatible` as a pool-health warning.
5. Add a job-ownership map keyed by the id fields in `PROVIDER_PROFILES`, and
   a "mutation may have happened" guard in failover (requirement 5).
6. Expose the policy and snapshots read-only in the admin UI, then editable.

## Testing

~~~bash
npm test                                   # build + all suites
npx tsc -p tsconfig.json && node --test test/tool-policy.test.mjs test/provider-capabilities.test.mjs
~~~

The tests use in-memory fixtures only. They make no live provider calls and
use no secrets.
