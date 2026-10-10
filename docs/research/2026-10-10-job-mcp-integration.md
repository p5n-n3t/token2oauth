# Token2OAuth job MCP integration boundary

Branch: `feat/t2o-job-mcp-integration-20261010`, based on integration commit `b6122fe`.

## Implemented boundary

OAuth metadata advertises `mcp`, `jobs:read`, and `jobs:write`; consent retains only the exact admin-approved requested scopes in access and refresh tokens. The default request remains `mcp`, so existing MCP-only clients do not silently receive job access. `mcp` is still required for every gateway request.

When a durable backend is injected, `tools/list` adds the six reserved local tools (`job_submit`, `job_status`, `job_workers`, `job_results`, `job_control`, `job_inbox`) according to their required scope. `job_submit` and `job_control` require `jobs:write`; the rest require `jobs:read`. Exact `tools/call` names are intercepted after OAuth authentication and before tool policy, account selection, or upstream I/O. Missing scopes return HTTP 403; malformed submissions return JSON-RPC invalid-params; a missing backend fails closed. An upstream tools/list name collision produces a JSON-RPC server error. Ordinary non-job requests continue through the existing pool/proxy path.

`job_submit` takes one closed-schema DAG: one to fifty eligible account IDs (single-account jobs are valid), one to one hundred unique tasks, at most eight dependencies per task, safe `record:`/repository-relative `path:` scopes, at most 16 KiB instructions and 1 MiB serialized input. Outputs support bounded JSON-records, text, and coding-artifact receipts. Hashes and record IDs are required only by the JSON-records output contract; coding tasks do not require record hashes. Project/account membership and idempotency persistence are delegated to the durable backend.

`buildApp` and `startServer` accept an optional `SupervisorBackend`; no child process or Python runtime starts by default. The admin surface mounts a backend read endpoint and revision-checked control endpoint behind the existing admin session and CSRF checks. The MCP result DTO is transported as bounded tool text. No prompts, payload bodies, or credentials are logged by this boundary.

## Integration and limitations

The R13/R14 bridge, R12 provider adapter, R11/R14 scheduler, and R15 UI are not present in base `b6122fe`. The injected `SupervisorBackend` is therefore an integration seam, not a claim of compatibility with their not-yet-available class or IPC DTOs. The default deployment has no durable job service: local calls return unavailable until the actual bridge is adapted and explicitly injected. This change does not implement polling, account reservation, remote LightSprint calls, output persistence, recovery, or project/account authorization. The concrete backend must enforce per-client project isolation, configured account eligibility, and durable idempotency before accepting submissions. Admin data rendering is also pending the R15 UI.

Pure-local JSON-RPC batches preserve IDs and notifications. Mixed batches containing both job and ordinary calls currently fail closed with HTTP 400 rather than splitting one JSON-RPC batch across local and upstream execution. Single ordinary calls and ordinary-only traffic are unchanged. The eventual R13/R14 integration must add an explicit mixed-batch strategy if clients require it.

## Verification

`npm test` passes: 140 tests, including strict TypeScript compilation and three new job-boundary tests. The tests exercise bounded DAG validation, independent read/write scopes, legacy `mcp`-only visibility and denial, no upstream leakage for local calls, backend delegation of the submitted idempotency key, and ordinary upstream routing. No dependencies were installed; the existing local dependency tree was temporarily linked for the test run and removed afterward.
