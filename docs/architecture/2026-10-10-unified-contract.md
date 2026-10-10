# Token2OAuth × Snooze unified execution contract

**Assignment:** T2O-A01-20261010
**Verified:** 2026-10-10
**Baselines:** Token2OAuth `origin/main` `7d084c64`; Snooze `origin/codex/snooze-command-centre` `1e2b56e`

## Decision and trust boundary

Embed a pinned Snooze source snapshot under Token2OAuth `supervisor/` as the first job engine; do not rewrite its Python SQLite task repository, scheduler, monitor, event feed, or outbox. Keep the standalone Snooze repository and its defaults/CLI intact. Give the embedded instance a new private database under Token2OAuth's config directory (never the standalone Snooze state path). Snooze owns assignments, DAG tasks, attempts, leases, events, incidents, and notifications transactionally. Node remains the only owner of OAuth/admin identity, encrypted upstream credentials (`StateStore`), LightSprint MCP transport, and the public HTTP surface. Python receives stable account IDs and operation results, never provider credentials or access tokens.

Use a local Unix-domain HTTP socket at `<configDir>/supervisor.sock`, mode `0600`. Node starts the child, creates a fresh 256-bit bridge bearer in memory, and passes it over a dedicated inherited pipe (not argv, environment, or logs). The child requires that bearer on every request; Node unlinks the socket on orderly shutdown. This authenticates the bridge for the same-UID local-process threat model; same-UID compromise is outside this boundary. Preserve existing `/mcp`, OAuth, and admin paths and all current permissions; expose job submission only to explicitly granted `mcp jobs:write` clients.

## Consumer and IPC contract (new Token2OAuth routes)

MCP `job_submit` receives one complete authorized DAG. The token must retain `mcp` and separately carry admin-granted `jobs:write`; admin drafts remain optional. Only show the local tool in `tools/list` when both scopes exist and intercept its exact `tools/call` after authentication, before pool/upstream. Unauthorized direct calls return HTTP 403 `insufficient_scope`; never fall through. Handle batches and notifications with IDs preserved; reject upstream name collisions. All other MCP behavior stays unchanged.

`job_submit` input is a closed object: `{schemaVersion:1,jobId,idempotencyKey,projectId,eligibleAccountIds,tasks}`. `eligibleAccountIds` contains 2–50 distinct, configured, admin-approved account IDs. A task has `taskId,dependsOn,scopeKeys,inputRef,inputSha256,instructions,execution,output`; there is no job-level `accountId`. The tool returns an accepted job receipt (`jobId,state:"queued",taskCount,revision`) promptly; status/events are read through the admin API below. This is explicit DAG execution, not automatic decomposition.

Public JSON routes, all under the configured base path; mutations require the existing admin session plus a CSRF value in `X-CSRF-Token` (validated by the same session service):

- `POST /admin/api/v1/assignments` — optional operator-created **draft** path.
- `POST /admin/api/v1/assignments/{assignmentId}/approve` — optional approval for an admin draft; never a prerequisite for an already-authorized `job_submit`.
- `GET /admin/api/v1/assignments?projectId=p&offset=0&limit=50` — bounded list `{ "assignments":[], "total":0, "offset":0, "hasMore":false }`.
- `GET /admin/api/v1/assignments/{assignmentId}` — current normalized snapshot.
- `GET /admin/api/v1/events?after=0&limit=100` — bounded cursor feed, `1 <= limit <= 200`.
- `POST /admin/api/v1/control` — `{ "action":"pause_dispatch"|"emergency_stop", "value":true, "expectedRevision":1 }`.

Node maps these to the same paths on the private socket, preserving JSON. Python returns `400` invalid contract, `401` bad IPC bearer, `404` missing ID, `409` stale revision/state conflict, and `202` accepted draft/command. No public handler calls Snooze SQLite directly.

Provider work crosses back to Node through the same private socket's durable operation outbox. The Node worker calls `POST /v1/operations/claim` with `{ "workerId":"node-1", "leaseSeconds":30 }`; Python returns `204` when empty or `{ "operationId","attemptId","generation","selectedAccountId","kind","providerTaskId","sessionId","input" }`. `kind` is one of `create_task|patch_task|verify_task_packet|launch_task|inspect_task_agents|observe_session|chat_session|cancel_session`; `input` is a closed per-kind DTO containing only IDs and bounded operation data. The operation row is committed before it can be claimed. Node performs exactly that account-pinned call, then posts `/v1/operations/{operationId}/result` with `{ "workerId":"node-1", "outcome":"accepted|rejected|ambiguous", "observedAt":"ISO-8601", "result":{"providerTaskId":"…","sessionId":"…","branchName":"…","commitRef":"…","artifactRefs":[],"pullRequest":{"url":"…","status":"…"},"reportedModel":"…","status":"…"}, "errorClass":"…" }`. Omit inapplicable fields; bound and allowlist references; never return raw response bodies. Replaying an identical result is idempotent; a conflicting result is `409`. An expired claimed operation becomes ambiguous and is reconciled, never re-claimed for a side-effecting call. Read-only observations may be retried with a new operation ID.

`POST assignment` body (closed schema, `schemaVersion` exactly `1`):

```json
{
  "schemaVersion": 1,
  "assignmentId": "opaque-client-id",
  "idempotencyKey": "opaque-key",
  "projectId": "configured-project-id",
  "eligibleAccountIds": ["account-a", "account-b", "account-c"],
  "tasks": [{
    "taskId": "extract-01",
    "dependsOn": [],
    "scopeKeys": ["path:src/data.json"],
    "inputRef": "opaque-local-reference",
    "inputSha256": "64-lowercase-hex-digits",
    "instructions": "bounded task instructions",
    "execution": {"mode": "fresh", "provider": "codex"},
    "output": {"kind": "json-records", "validator": "json-records", "ids": ["r-1"], "requiredFields": ["id", "value"]}
  }]
}
```

Accept 1–100 unique tasks (configurable only up to 1000), at most 8 dependencies per node; require an acyclic DAG, dependencies within the same job, unique IDs, and exact approved `record:ID` or safe repository-relative `path:` scopes. Cap each instruction at 16 KiB and total job JSON at 1 MiB. `inputRef` is an opaque reference, not an arbitrary URL or payload. Output is a tagged union: `json-records` uses the existing structural validator and exact IDs/required fields; `text` declares `maxBytes` (1–32 KiB) and format; `coding-artifact` declares repository, allowed paths, and whether a PR is required. Coding receipts record actual server-returned branch, commit/artifact references, and PR URL/status when present; they do not assume that every execution creates a PR. No task-supplied code validators. Reject duplicate scopes, path traversal, unknown/ineligible accounts/project, and unsupported fields. Enforce unique `(projectId,idempotencyKey)`; duplicates return the original job receipt. Internal task IDs are `<jobId>:<taskId>`.

`execution.mode` is `fresh` or `existing-session`. Existing sessions must be explicitly registered idle sessions owned by one listed account; Node rechecks status immediately before sending. For a fresh run, `provider` is `claude|codex|auto|pi`. The API cannot select a fresh-run model: expose `modelRequested` as unknown/unsupported, and separately record `modelReported` from session status. Existing approved `gpt-6-luna` sessions may be retained and safely messaged by the registered-session mode; do not claim that this selects the model for a fresh launch.

Snapshot DTO: `{schemaVersion,jobId,projectId,eligibleAccountIds,state,revision,tasks:[{taskId,state,dependsOn,attempt,generation,selectedAccountId,providerTaskId,sessionId,branchName,commitRef,pullRequest,modelRequested,modelReported,providerStatus,quota,capacity}]}`. `selectedAccountId` is null until reservation and durable thereafter. `quota` and `capacity` remain provenance-bearing observed/unknown values. Do not return instructions, provider message bodies, tool payloads, or secrets from snapshots/events.

## Ownership, upstream calls, and state

Only the Python scheduler claims/reserves work. In one SQLite `BEGIN IMMEDIATE` transaction, choose an eligible account by least active load, then fewest tasks already selected for this job, then a persisted round-robin tie cursor. Atomically persist that task's `selectedAccountId`, attempt generation/idempotency key/lease, operation-outbox row, and event after checking ownership, DAG readiness, scope overlap, and local limits. Seed a safe local ceiling of one active attempt per account; with 35 ready tasks and 9 eligible accounts, the first wave must spread across all 9 before any account receives a second. If fewer than two accounts remain eligible, keep the job queued and report that fanout cannot be met instead of collapsing onto one account. After selection, account affinity is immutable for launch, status, resume, and cancellation; errors do not fail over. A lease is a local recovery timer, not proof that a provider stopped. No in-memory request semaphore is capacity evidence.

Node's account-pinned `LightSprintJobsAdapter` is the sole caller of `lightsprint_api` through the native MCP URL. For fresh work, use documented operations: `POST /api/tasks` with `{title,scope:"stack",stackId}`, `PATCH /api/tasks/{taskId}` with the complete task packet, then `GET /api/tasks/{taskId}` and byte/field-verify the full description roundtrip before launch. Only then call `POST /api/tasks/{taskId}/lightsprint-agents/{provider}` with `{autoMerge:false}`; do not send or promise a caller-selected `branchName`. Persist each returned remote ID and server-generated branch before the next step. Ordinary Node code assembles these exact bodies; never use an LLM to construct/truncate the provider payload. A packet mismatch blocks launch. No direct REST credentials, undocumented endpoint, hidden browser call, model catalog, quota query, capacity query, or provider failover.

A create/launch timeout is **ambiguous**, never an automatic retry. Persist the operation phase and any known task ID; reconcile a known task with documented task/agent reads before proceeding. If creation's response was lost and no unique remote task can be proved, stop for operator reconciliation. The remote API exposes no idempotency contract. Keep the account pinned through launch, status, chat, and cancellation.

Existing-session continuation is now verified across nine accounts with exact body `{message,clientMessageId}`. Persist a unique continuation ID before `POST /api/agent-sessions/{id}/chat`; send once, and on timeout/connection loss mark ambiguous and reconcile status—never resend an ambiguous message. Registered idle sessions may run their approved bounded task packet with `gpt-6-luna`. Poll documented session status; idle/completed/failed alone does not prove task completion or release scopes. Validate bounded text or saved coding/JSON artifacts against the declared output contract, then mark complete and release. Provider-confirmed cancel or explicit audited manual ownership resolution are the only other release paths.

Fresh task launch is also verified. A codex launch through the Claude Code gateway produced a real assistant marker, and stop was confirmed cancelled; its reported model was default `gpt-6.1-sol`. A caller-supplied branch name did not control the resulting server-generated `ls/...` branch. Therefore store `modelRequested` as unsupported/unknown and `modelReported` as observation; likewise always use the actual returned branch. Do not represent a provider choice as exact model selection.

Task lifecycle: authorized `job_submit -> queued -> reserved(selectedAccountId fixed) -> starting -> running -> awaiting_output -> validating -> complete`; admin draft/approve is optional. Retries remain on the same selected account. Operator may set `held`; invalid output/policy becomes `blocked`; bounded recoverable failure may become `retry_due`; cancellation is `cancel_pending -> cancelled` only after confirmation. An attempt can be `reserved|starting|running|awaiting_output|validating|ambiguous|blocked|complete|cancel_pending|cancelled|failed`. Stale-generation artifacts are quarantined. Unknown, idle, unavailable, or failed observations never imply completion or release.

## Quota, capacity, recovery, and administration

LightSprint has no documented remaining-credit or worker-capacity endpoint in the reviewed schema. Initialize both as unknown. Account eligibility comes from explicit admin registration, auth health, supported operation, and operator policy; unknown credit may proceed only where that account's explicit `allow_unknown_quota` policy permits. HTTP 402/429 are reactive failure signals and can trigger per-account cooldown, not a balance. The local ceiling of one prevents duplicate ownership; it is not reported provider capacity. Never infer slots from successful prompts or Token2OAuth request concurrency. To distribute, scheduler selects among many eligible accounts rather than failing one account's task over to another after dispatch.

Run initially on one Token2OAuth host with multiple scheduler/monitor processes coordinating via the local SQLite file and its transactional locks. This is durable single-host multi-process scheduling, not multi-host HA: do not put SQLite on an unverified network filesystem or claim cluster-wide exactly-once dispatch. Multi-host availability requires a separately approved transactional server database/leader design.

After restart, scan unreleased attempts, re-observe known session IDs, and reconcile known task IDs before recovery. Unknown provider state, auth loss, expired lease, or missing artifact holds scope and raises an incident; no blind reassignment. Bound resume to operator policy (maximum two recoveries, exponential backoff), with dispatch pause/emergency stop honored. Reuse Snooze's persistent event cursor and outbox: delivery is at-least-once with stable delivery IDs; receiver deduplicates; acknowledgment is not resolution, which requires verified state-change evidence. With no configured notifier, keep incidents in the durable inbox.

Expose admin queue, task/attempt detail, event cursor, account binding/health, policy revision, pause/emergency stop, incident acknowledge/resolve, and explicit reconciliation. Account labels shown in UI/logs should be configured privacy-safe aliases; internal stable IDs are not credentials. Persist only allowlisted status fields and error classes. Keep Token2OAuth's telemetry bounded/in-memory for request latency/outcomes; correlate by assignment/task/attempt IDs, but never persist prompts, MCP bodies, bearer tokens, or raw provider errors.

## Ownership and implementation increments

1. Vendor/pin Snooze under `supervisor/snooze/`, record upstream SHA/license, isolate DB/config, and prove standalone Snooze tests/default state are unchanged.
2. **Mandatory first execution increment:** implement `job_submit` MCP scope/tool interception in `src/proxy.ts` and OAuth client consent/token scope checks in `src/oauth.ts`/`src/types.ts`; keep `mcp` required and require separately granted `jobs:write`. Add schemas/tests in `src/job-submit.ts` and `test/job-submit.test.mjs`. The tool accepts the whole DAG once and enters queued/approved state directly.
3. Implement Node IPC client/router and DTO validation in `src/supervisor-bridge.ts` and `src/supervisor-api.ts`; `server.ts` only mounts it. Python socket entrypoint owns bridge serving and existing SQLite modules under `supervisor/`.
4. Implement durable multi-account reservation/fairness and `selectedAccountId` in `supervisor/snooze/`; its tests own transaction, no-overlap, 35-task/9-account spread, idempotency and crash recovery. Never defer core fanout to an optional later layer.
5. Implement Node-only account-pinned provider calls in `src/providers/lightsprint-jobs.ts`; do not reuse Snooze's direct-token adapter. Verify full task packet roundtrip before launch; use verified `{message,clientMessageId}` continuation exactly once; record actual reported model and server branch.
6. Support all three tagged output validators and artifact/branch/PR receipts in `supervisor/`; separately owned tests validate bounded text, exact JSON records, allowed coding paths, commit/artifact refs and optional/required PR policy.
7. Add isolated admin rendering in `src/supervisor-ui.ts`; minimally mount it from `ui.ts`. Provider/inbox UI must not share bridge, scheduler, or adapter files. Preserve Snooze standalone modes and project database semantics.

Contract tests: OAuth client with only `mcp` sees no job tool and direct call is denied; admin-granted `mcp jobs:write` sees/calls the intercepted local tool without upstream forwarding; ordinary tools still proxy unchanged. Check input bounds/DAG cycles; duplicate idempotency; concurrent reservation and 35-task/9-account spread; immutable task account affinity after errors/restart; atomic task/event/outbox writes; full PATCH roundtrip blocks launch on truncation; exact chat body and ambiguous no-retry; actual branch/model observation; JSON/text/coding artifact validation; lease expiry never releases ownership; unknown credit/capacity; IPC auth; no credentials/prompts in persistence; outbox dedupe; standalone Snooze regression.

## Evidence and limitations

R01 and R04 reports are at `origin/research/t2o-r01-lightsprint-20261010` and `origin/research/t2o-r04-clients-auth-20261010`. Snooze evidence is its `TaskRepository.reserve/update_attempt/release`, `Scheduler.tick`, `Monitor`, `EventFeed`, `Outbox`, and LightSprint adapter on the stated baseline. Token2OAuth evidence is `src/store.ts`, `src/server.ts`, `src/provider-capabilities.ts`, `src/telemetry.ts`, and `src/ui.ts` on `origin/main`.

Official LightSprint interface reference (verified 2026-10-10): https://app.lightsprint.ai/docs/mcp/ . **Executed evidence in the authorized assignment:** nine-account chat verification with `{message,clientMessageId}`; existing idle `gpt-6-luna` session continuation; fresh codex task launch with assistant output and confirmed cancellation; PATCH roundtrip finding that the Claude executor truncated a long description until corrected before launch. Keep the deterministic Node roundtrip check before any launch. Exact fresh model selection, quota balance, live agent capacity, and upstream operation idempotency remain unsupported/unknown. A verified launch's `gpt-6.1-sol` is a reported default, not a selectable model. A supplied branch name did not override the generated `ls/...` branch; persist the returned value. HTTP 200 containing inner 402 was fixed in the merged `development` commit `00e3e77`; the reported 123 tests passed there. These are assignment-provided verification results, not rerun in this documentation-only amendment.
