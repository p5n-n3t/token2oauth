# Telemetry primitives

`src/telemetry.ts` provides bounded, dependency-free building blocks for
gateway diagnostics. **It is not wired into the server, proxy, CLI or admin
console yet** — nothing records events at runtime until a later change calls
it. Import it from `dist/telemetry.js` after `npm run build`.

## Two kinds of data, kept apart

| | Gateway events | Provider usage |
|---|---|---|
| What | What Token2OAuth observed: `request`, `attempt` (one upstream try, per account), `probe` (credential health check) | Values a provider *reported*: tokens, model, credits |
| Fields | `method`, `tool`, `accountId`, `pool`, `status`, `latencyMs`, `retries`, `outcome`, `errorClass` | `metric`, `value`, `unit`, `source`, `observedAt`, `model`, `accountId`, `pool` |
| Required | `kind` | `metric`, `source`, `observedAt`; `unit` when a value is reported |
| Missing data | fields omitted | `availability: "unavailable"`, `value: null`, optional `reason` |
| API | `recordGateway`, `recent`, `summary`, `timeSeries` | `recordProviderUsage`, `providerUsage`, `latestProviderUsage` |

Provider usage is **never inferred**. An HTTP 200, a request count or a
successful probe does not create, estimate or change any token or credit
value. Only call `recordProviderUsage` with a value from a real provider
signal (an official usage endpoint, a documented response header or a usage
block in the response body), and name that signal in `source`. When a
provider exposes no usage, record it as unavailable rather than guessing.

## Bounds

| Structure | Bound | Default |
|---|---|---|
| Gateway event ring | `capacity` events; oldest evicted, counted in `stats().dropped` | 1000 |
| Provider usage ring | `providerCapacity` records | 500 |
| Time buckets | `bucketCount` fixed slots of `bucketMs`; older events ignored | 60 × 60 s |
| Summary dimensions | `maxDimensionValues` per dimension, rest folded into `(other)` | 50 |
| Dimension values | control chars stripped, 128 chars max | — |
| Captured payloads | depth 4, 256-char strings, 30 keys, 20 array items | off |

`summary()` covers the events still in the ring (its `window` says how many and
how many were evicted). `timeSeries()` returns per-bucket counts, success,
error, retries, latency sum/count/max and per-kind counts for the full window,
including empty buckets.

## Redaction and rendering

- `redact(value)` returns a JSON-safe copy. Keys that name secrets
  (`Authorization`, `Cookie`, `Set-Cookie`, `password`, `*secret*`, `api_key` /
  `X-Api-Key`, `*_token`, `Mcp-Session-Id`, private/access keys, credentials)
  become `[REDACTED]`; usage counters such as `input_tokens` are kept.
  Strings are scrubbed for `Bearer`/`Basic` credentials, JWTs, common provider
  key prefixes (`sk-`, `ghp_`, `github_pat_`, `xox*-`, `AKIA…`), `key=value`
  secrets in URLs/forms/cookies (including OAuth `code` and `code_verifier`)
  and secret fields inside serialized JSON. Cycles become `[Circular]`, deep
  nesting `[MaxDepth]`; long strings, arrays and objects are truncated with a
  marker; binary data, errors, functions, bigint and dates are summarized.
  Control and bidi characters are removed. It never throws or mutates input.
- Request payloads are **not** stored unless the recorder is created with
  `capturePayloads: true`; even then they are redacted and size-limited.
- `formatGatewayEvent`, `formatProviderUsage` and `formatSummary` are the
  rendering boundary. They escape every user-controlled value with
  `escapeLogValue` (logfmt-style quoting, `\n`/`\"`/`\\` escapes, `\uXXXX` for
  control/bidi characters), so a tool name or error message cannot inject a
  new log line or fake field. Messages and payloads are redacted again at
  render time, so hand-built events are safe too.

Example output:

~~~text
2026-10-07T06:00:00.000Z attempt error method=tools/call tool=search account=acct-1 pool=main status=429 latency=120ms retries=2 error=quota
2026-10-07T05:59:00.000Z provider-usage metric=credits_remaining value=41.5 unit=credits account=acct-1 source=provider-usage-api
2026-10-07T06:00:00.000Z provider-usage metric=credits_remaining value=unavailable account=acct-2 source=none reason="no usage API"
~~~

## Usage

~~~ts
import { TelemetryRecorder, formatGatewayEvent, formatSummary } from "./telemetry.js";

const telemetry = new TelemetryRecorder({ capacity: 2000 });

const event = telemetry.recordGateway({
  kind: "attempt",
  method: "tools/call",
  tool: "search",
  accountId: account.id,
  pool: "default",
  status: 200,
  latencyMs: 84,
  retries: 0,
});
console.log(formatGatewayEvent(event));
console.log(formatSummary(telemetry.summary()));
~~~

`outcome` defaults from `status` (1xx–3xx success, anything else or a missing
status / present `errorClass` is an error). Pass `outcome` explicitly when the
gateway knows better, for example a JSON-RPC error inside an HTTP 200.

## Integration steps (not done in this change)

1. Create one `TelemetryRecorder` in `buildApp` and pass it to the proxy and
   pool (or expose it on `app.locals`).
2. In `src/proxy.ts`, record one `attempt` per upstream try (with `accountId`,
   status, latency, `errorClass` from `CredentialPool.classifyFailure`) and one
   `request` per client request with the final status and retry count. Read
   `method`/`tool` from the parsed JSON-RPC body; leave payload capture off.
3. In `CredentialPool.probe*`, record a `probe` event per credential.
4. Add an authenticated admin endpoint (and optionally a CLI command) that
   returns `summary()`, `timeSeries()`, `recent()` and `latestProviderUsage()`;
   render text with the `format*` helpers or JSON as-is.
5. Only add provider usage once a provider publishes a real usage signal;
   otherwise show "unavailable".
6. If payload capture is ever exposed, make it an explicit, persisted opt-in
   setting documented in `docs/CONFIGURATION.md`.
