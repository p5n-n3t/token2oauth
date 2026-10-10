# Legacy LightSprint account compatibility repair

**Assignment:** T2O-R18-20261010
**Base:** `codex/unified-platform-20261010` at `d229bbc0069860e143e3a4a6441242b3b07e7cd3`
**Scope:** Adapter compatibility, focused mocked regressions, and this report. No registry, server, pool, or deployment changes.

## Finding and correction

The integration finding supplied with this assignment reports that configured LightSprint credentials are persisted with the legacy provider label `generic-bearer-mcp`, while the global upstream is the native LightSprint MCP URL. The adapter previously required the explicit provider label and rejected these records.

The adapter now accepts enabled explicit `lightsprint` accounts, and accepts legacy `generic-bearer-mcp` accounts only when `state.config.upstreamUrl` parses and canonicalizes exactly to `https://app.lightsprint.ai/mcp` (HTTPS, exact host/path, no userinfo, query, or fragment). Other providers and generic credentials targeting other URLs are rejected before token reveal or client creation. All accepted accounts still connect only to the fixed native endpoint; HTTP redirects are refused.

Before each API operation the adapter reloads state and checks account existence, enabled state, and provider/endpoint compatibility, even when an MCP client is cached. Since persisted accounts have no revision field, it re-reveals the selected token, compares a one-way digest, and discards/rebuilds the client if the credential changed. Disabling or removing an account blocks subsequent I/O. Chat continues sending the current `message` and its `clientMessageId` exactly.

## Evidence status

- **Executed:** focused mocked regression tests cover canonical legacy acceptance, mismatched URL rejection before credential use/client creation, cached-account disablement, token rotation, and the exact message/clientMessageId request body. The full `npm test` suite is the required verification; no live account or paid call is used.
- **Documented:** LightSprint's native MCP endpoint is `https://app.lightsprint.ai/mcp`, matching the repository provider profile. URL parsing, fixed endpoint construction, JSON/SSE transport, and no-redirect behavior are implemented in this adapter.
- **Unsupported:** credentials for generic MCP targets cannot be forwarded to LightSprint; no live registry mutation, server route, or account migration is included.
- **Experimental:** none; all service-facing behavior in this repair is mocked.
- **Unknown:** this branch does not independently reproduce the supplied integration runtime observation or verify live LightSprint auth/permissions. Deployment and any broader registry normalization remain outside scope.
