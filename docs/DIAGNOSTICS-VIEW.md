# Diagnostics view scaffold

This change adds a standalone renderer. It does not add an admin route, collect logs, or connect the renderer to `AdminUi`. The current proxy has useful integration metadata in `src/proxy.ts` (upstream status, configured provider/account, and MCP session IDs); `CredentialPool` tracks aggregate per-account health. The server does not currently assign request IDs or retain structured request events. The renderer accepts correlation fields when a future producer supplies them.

## API

`formatDiagnosticEntry(input, mode?, options?)` is a pure formatter. `mode` is `"readable"` by default or `"json"` for indented, key-sorted structured output. `options.maxChars` defaults to 6,000 characters per entry; values below 64 are raised to 64. String input is parsed as JSON when possible. Malformed JSON is labeled and preserved as bounded text. Likely credential fields and bearer/JWT-like strings are redacted in both modes.

Readable output shows timestamp, normalized severity, provider, pool/account, request correlation, session correlation, message, and remaining structured fields when present. Accepted aliases include common `requestId`/`request_id`, `sessionId`/`Mcp-Session-Id`, and timestamp spellings. Missing values are shown as unknown or unavailable; no provider metadata is fabricated.

`renderDiagnosticsView(entries, options?)` returns a complete script-free HTML document. It defaults to at most 200 entries (clamped to 1–1,000), uses semantic headings, a labeled ordered list, and native `<details>/<summary>` controls for redacted raw JSON. All dynamic text is HTML-escaped; no log data is placed in scripts, attributes, or event handlers. Entry text is bounded before HTML rendering and omitted entries are announced with a status message. The page states that upstream provider log availability is unknown.

## Future integration

An authenticated diagnostics page can be added to `AdminUi` after a local event source exists. Keep it behind the existing `requireAdmin` session guard and `t2o_admin` cookie, including the configured base path and the existing unprefixed route behavior. A same-origin browser `EventSource` can then connect with the session cookie; never put a session token in the URL. Set `Content-Type: text/event-stream`, disable response buffering and caching, send periodic comments as heartbeats, and close streams on logout/session expiry or server shutdown.

Assign monotonically increasing event IDs within the retained stream and use SSE `id:` fields. On reconnect, resume after `Last-Event-ID` only while that cursor remains in retention. Bound retention by both age and count/bytes. If the requested cursor is older than retained history, send an explicit reset/gap event and have the page reload a bounded snapshot before reconnecting. Keep the browser's rendered list bounded as well; reconnecting does not promise durable history across process restarts unless a persistent event store is later added.

Redact before retaining or emitting events, and retain only operational fields needed for support. The current application does not collect a structured log stream, assign request IDs, or expose upstream provider internal logs. Provider log availability remains unknown unless a provider explicitly supplies logs through a future supported integration; do not infer it from Token2OAuth request or pool records.
