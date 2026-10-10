# Local MCP discovery for durable jobs

At integration head `66995782f0df5eafcb4fafdc4244253d860f11e6`, local `tools/call` requests for OAuth-authorized durable-job tools were already intercepted before upstream selection, but an empty `upstreamUrl` returned HTTP 503 before clients could initialize or discover them. The proxy now serves local MCP initialization and `tools/list` only when the supervisor is enabled, the upstream URL is empty, and the caller has at least one matching `jobs:read` or `jobs:write` scope. Discovery returns only that caller's authorized local job tools. Initialization negotiates supported versions `2025-06-18` and `2025-03-26`, advertises `tools.listChanged: false`, and identifies Token2OAuth; `notifications/initialized` receives an empty HTTP 204 response.

Requests for ordinary MCP methods still return 503 without an upstream. Existing upstream-backed proxying remains unchanged, and exact job `tools/call` requests keep using the existing scoped interception. No OAuth scopes were broadened and no upstream fallback was added.

## Verification

- `node --test test/job-submit.test.mjs`: 3/3 passed, including a real HTTP/OAuth fixture verifying local read/write tool lists, initialization, notification response, exact `job_submit` interception, no upstream traffic during local handling, unconfigured ordinary-client 503, and normal proxying after configuring upstream.
- `npm test`: TypeScript build passed; 190/191 passed. Existing unrelated `real Python IPC registers two accounts, completes pinned tasks, isolates callers, and resumes durable results` timed out with tasks still `awaiting_output` in `test/supervisor-runtime.test.mjs:86`.
