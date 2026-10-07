# Routing safety helpers

`src/routing-safety.ts` contains standalone retry, query, and upstream
ownership helpers. The current proxy does not import them yet; this note
describes the integration points without changing the running proxy.

## Retry decisions

`classifyRetryFailure` recognizes transport failures, selected HTTP statuses,
JSON-RPC errors, and MCP tool results with `isError: true`. HTTP retries default
to 401, 402, 408, 425, 429, 500, 502, 503, and 504. JSON-RPC errors are
non-retryable unless a caller explicitly marks one or supplies its code in
`retryableJsonRpcCodes`. A tool error is a failure signal, but it does not make
the tool safe to replay.

`decideRetry` is the gate for replay. It permits known read-only MCP methods and
tools named by the caller's read-only allowlist. Mutating and unknown tool
calls, `initialize`, and unknown RPC methods are denied by default. It also
applies a capped `Retry-After` delay and rejects a retry when the requested
delay reaches the total elapsed-time deadline. Callers should pass elapsed
time for the whole operation, not reset it for each account attempt.

## Query forwarding

`mergeIncomingQuery(upstreamUrl, incomingUrl)` retains every configured
upstream query parameter and appends every incoming parameter, including
repeated keys. The proxy currently assigns `incoming.search` to
`target.search`, which discards the configured upstream query; the helper can
replace that assignment when the proxy is wired to it. It does not accept,
read, return, or log upstream bearer credentials.

## Session and task ownership

Use one `UpstreamOwnershipRegistry` per proxy process. Before calling
`CredentialPool.pick`, resolve the incoming `Mcp-Session-Id` and any
`tasks/get`, `tasks/result`, or `tasks/cancel` request. A resolved owner must
be selected directly regardless of whether the pool strategy is adaptive,
round-robin, least-used, weighted-random, random, or priority. Call
`authorize(accountId, resolution)` before forwarding; a foreign owner,
unknown session or task handle, or conflicting session/task owners is a
fail-closed result and must not be forwarded to another credential.

After an upstream response establishes an MCP session, bind both the incoming
session ID (when present) and the returned upstream `Mcp-Session-Id` to the
account that handled the response. When a response creates a task, obtain its
handle with `taskIdFromResponse` and bind that task ID to the same account.
Keep those bindings when a client supplies the task ID on a later follow-up.
`bindSession` and `bindTask` refuse to reassign a handle already owned by a
different account. Check each binding result; if an upstream reuses a session
or task ID that is already owned by another account, do not return that
ambiguous handle to the client.

## Current proxy integration points and limits

- `McpProxy.handler` currently retries eligible upstream HTTP and transport
  failures after sending the request body. It does not use the JSON-RPC method
  or tool metadata to decide whether replay is safe, and it cannot inspect a
  streaming response body before returning it.
- `CredentialPool.pick` honors session affinity only for `adaptive-sticky`.
  Resolve ownership before strategy selection to preserve affinity under every
  strategy. Existing `CredentialPool.bindSession` remains separate until the
  proxy is wired to this registry.
- Parse a complete JSON-RPC response before treating JSON-RPC or tool errors as
  retry signals. Do not retry a streamed response after bytes have been sent
  downstream.
- The registry is in-memory and process-local. A restart loses its bindings;
  a future integration must either persist them or fail closed for task
  follow-ups whose owner is no longer known. The helpers do not implement
  account selection, HTTP status mapping, persistence, or proxy wiring.
- The helpers never receive or expose upstream keys. Keep authentication
  headers out of logs and continue to use the existing encrypted credential
  store for tokens.
