# Changelog

## 0.2.0 - 2026-10-07

Integration release (PRs #1–#6, #8–#10; #7 rejected as a duplicate of #3).

- Admin security: CSRF on every admin form and on session-authorized OAuth consent, safe login redirects, path-scoped admin cookie, login throttling, security headers, epoch-bound sessions and authorization codes, password regeneration from the dashboard or CLI (shown once) with optional revocation of all MCP client tokens.
- Tool policy: per-account tool inventory, dashboard/CLI enable-disable enforced server-side on `tools/call` and `tools/list` (JSON and SSE).
- Routing safety: failover only after pre-execution rejections (401/402/429/quota) or for read-only/replay-safe requests; MCP sessions and tasks stay on their owning credential under every strategy; unknown sessions are rediscovered after restarts; upstream URL query parameters are preserved; decoded responses no longer carry a stale `content-encoding`.
- Diagnostics: bounded in-memory telemetry, analytics by account/tool, humanized event log, honest "unavailable" quota labelling, runtime doctor with read-only checks and repair previews.
- Lifecycle: `token2oauth lifecycle status|up|down` pinned to `/token2oauth`, dry run by default; `tailscale expose` refuses other paths; installers refuse `/`.
- Multi-pool: validated schema and read-only `pools preview`.
- State files from 0.1.0 load unchanged; all new fields are optional.

## 0.1.0 - 2026-10-05

Initial public build with OAuth protected-resource and authorization-server metadata, DCR, authorization code plus PKCE S256, resource-bound access tokens, refresh rotation, encrypted credential pooling, adaptive sticky routing, MCP session affinity, rate-limit cooldown/failover, web admin, CLI, Tailscale-aware installer, systemd/Docker packaging, tests, and CI.
