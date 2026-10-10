# Token2OAuth × Snooze control-plane UI integration

Mounted `GET /admin/supervisor/:projectId` through the existing supervisor admin router, which is registered before `AdminUi`. The route requires the existing admin session and reads only `SupervisorBackend.readAdmin(projectId)`. Snapshot JSON and live-feed responses also require that session. Backend errors remain visible as a generic dashboard error; internal exception details are not reflected.

## Safety and behavior

- Every new supervisor HTML/JSON route sets `Cache-Control: no-store`, frame denial, `nosniff`, no-referrer, and a nonce-bearing CSP before authentication. Inline polling is nonce protected; styles are self-contained and there are no external assets.
- Admin data passes through the existing telemetry redactor and bounded object/array/string limits; encoded snapshots above 512 KiB are rejected. Normalization reads only recognized fields. Missing provider groups, quotas, health, and events remain unknown/empty; provider quota is never inferred from local worker capacity.
- The timeline is filtered by bounded `search`, `severity`, and `pause` query parameters. `/admin/api/v1/supervisor/:projectId/live` produces redacted/escaped event HTML and current supplied health from a fresh project-scoped backend read. The client polls same-origin every 15 seconds, shows errors, and changes only the event and health nodes so the workforce disclosures and unrelated focus remain intact. “Pause live updates” clears the timer; “Resume” restarts it; `pagehide` cleans up.
- No dispatch mutation controls were added to the UI. The existing revision-fenced control endpoint and CSRF check remain available and unchanged in behavior; invalid/missing revisions are rejected more strictly.

## Design

The operations desk keeps the cool paper/slate palette, ink hierarchy, restrained copper warnings, and nested provider → account → workspace → worker disclosures established in the standalone renderer. It remains responsive, keyboard-accessible, and reduced-motion aware. This is designed as a command view, not an extension of the dark settings form grid.

## Verification and limits

`test/supervisor-api.test.mjs` exercises admin authentication, response security headers, project scoping, bounded/redacted snapshots, filtered live payloads, visible backend failures, and unchanged CSRF enforcement for revision-fenced control. `test/supervisor-ui.test.mjs` covers normalization, escaping, unknown denominators, filtering, and nonce/pause/disconnect polling behavior. The test suite is run with `npm test`. No isolated browser preview was available for this worktree, so there is no screenshot proof; the frontend renderer is verified by tests and server response assertions only.
