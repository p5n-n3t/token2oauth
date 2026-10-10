# Token2OAuth × Snooze unified execution contract

**Assignment:** T2O-A01-20261010
**Verified:** 2026-10-10
**Baselines:** Token2OAuth `origin/main` `7d084c64`; Snooze `origin/codex/snooze-command-centre` `1e2b56e`

## Decision and trust boundary

Embed a pinned Snooze source snapshot under Token2OAuth `supervisor/` as the first job engine; do not rewrite its Python SQLite task repository, scheduler, monitor, event feed, or outbox. Keep the standalone Snooze repository and its defaults/CLI intact. Give the embedded instance a new private database under Token2OAuth's config directory (never the standalone Snooze state path). Snooze owns assignments, DAG tasks, attempts, leases, events, incidents, and notifications transactionally. Node remains the only owner of OAuth/admin identity, encrypted upstream credentials (`StateStore`), LightSprint MCP transport, and the public HTTP surface. Python receives stable account IDs and operation results, never provider credentials or access tokens.

Use a local Unix-domain HTTP socket at `<configDir>/supervisor.sock`, mode `0600`. Node starts the child, creates a fresh 256-bit bridge bearer in memory, and passes it over a dedicated inherited pipe (not argv, environment, or logs). The child requires that bearer on every request; Node unlinks the socket on orderly shutdown. This authenticates the bridge for the same-UID local-process threat model; same-UID compromise is outside this boundary. Keep the existing public `/mcp`, OAuth, and admin routes unchanged.

## Consumer and IPC contract (new Token2OAuth routes)

The initial consumer is an authenticated Token2OAuth administrator/console using existing admin-session and CSRF checks. Do not reuse MCP bearer tokens as job authorization; there is no existing machine `jobs:write` scope. A later service caller needs a separately designed, scoped credential.

Public JSON routes, all under the configured base path; mutations require the existing admin session plus a CSRF value in `X-CSRF-Token` (validated by the same session service):

- `POST /admin/api/v1/assignments` — validate and persist an assignment as **draft**; never dispatch on submission.
- `POST /admin/api/v1/assignments/{assignmentId}/approve` — `{ "expectedRevision": 1 }`; explicit operator approval is required before work can start.
- `GET /admin/api/v1/assignments?projectId=p&offset=0&limit=50` — bounded list `{ "assignments":[], "total":0, "offset":0, "hasMore":false }`.
- `GET /admin/api/v1/assignments/{assignmentId}` — current normalized snapshot.
- `GET /admin/api/v1/events?after=0&limit=100` — bounded cursor feed, `1 <= limit <= 200`.
- `POST /admin/api/v1/control` — `{ "action":"pause_dispatch"|"emergency_stop", "value":true, "expectedRevision":1 }`.

Node maps these to the same paths on the private socket, preserving JSON. Python returns `400` invalid contract, `401` bad IPC bearer, `404` missing ID, `409` stale revision/state conflict, and `202` accepted draft/command. No public handler calls Snooze SQLite directly.

Provider work crosses back to Node through the same private socket's durable operation outbox. The Node worker calls `POST /v1/operations/claim` with `{ "workerId":"node-1", "leaseSeconds":30 }`; Python returns `204` when empty or `{ "operationId","attemptId","generation","accountId","kind","providerTaskId","sessionId","input" }`. `kind` is one of `create_task|patch_task|launch_task|inspect_task_agents|observe_session|chat_session|cancel_session`; `input` is a closed per-kind DTO containing only the IDs, selected provider, title/description or session ID needed for that call. The operation row is committed before it can be claimed. Node performs exactly that account-pinned call, then posts `/v1/operations/{operationId}/result` with `{ "workerId":"node-1", "outcome":"accepted|rejected|ambiguous", "observedAt":"ISO-8601", "result":{"providerTaskId":"…","sessionId":"…","branchName":"…","status":"…"}, "errorClass":"…" }`. Omit inapplicable fields; never return raw response bodies. Replaying an identical result is idempotent; a conflicting result is `409`. An expired claimed operation becomes ambiguous and is reconciled, never re-claimed for a side-effecting call. Read-only observations may be retried with a new operation ID.

`POST assignment` body (closed schema, `schemaVersion` exactly `1`):

```json
{
  "schemaVersion": 1,
  "assignmentId": "opaque-client-id",
  "idempotencyKey": "opaque-key",
  "projectId": "configured-project-id",
  "accountId": "token2oauth-account-id",
  "tasks": [{
    "taskId": "extract-01",
    "dependsOn": [],
    "scopeKeys": ["path:src/data.json"],
    "inputRef": "opaque-local-reference",
    "inputSha256": "64-lowercase-hex-digits",
    "instructions": "bounded task instructions",
    "execution": {"mode": "fresh", "provider": "codex"},
    "output": {"validator": "json-records", "ids": ["r-1"], "requiredFields": ["id", "value"]}
  }]
}
```

Accept 1–20 unique tasks, at most 8 dependencies per node; require an acyclic DAG, dependencies within the same assignment, valid topological ordering, unique IDs, and exact approved `record:ID` or safe repository-relative `path:` scopes. Cap each instruction at 16 KiB and total assignment JSON at 256 KiB. `inputRef` is an opaque reference, not an arbitrary URL or payload. The only validator is the existing structural `json-records` validator; no task-supplied code. Reject duplicate IDs/scopes, path traversal, unknown account/project, and unsupported fields. Enforce unique `(projectId, idempotencyKey)`; repeats return the original assignment and revision. Task IDs are stable `<assignmentId>:<taskId>` internally.

For `execution.mode="resume"`, require `sessionId` and an explicit operator-approved resume action tied to the assignment revision. Pin it to the same configured Token2OAuth account; never route to another account. Fresh execution accepts only `claude|codex|auto|pi`. Model and reasoning-effort selection are not request fields because the exposed LightSprint launch schema does not support them.

Snapshot DTO: `{schemaVersion,assignmentId,projectId,accountId,state,revision,createdAt,updatedAt,tasks:[{taskId,state,dependsOn,attempt,generation,providerTaskId,sessionId,providerStatus,quota,capacity,updatedAt}]}`. `quota` and `capacity` are provenance-bearing `{known:true,value,source,observedAt}` or `{known:false,reason}`; absent data stays unknown/null. Do not return instructions, provider message bodies, tool payloads, or secrets from snapshots/events.

## Ownership, upstream calls, and state

Only the Python scheduler claims/reserves work. Reservation is one SQLite `BEGIN IMMEDIATE` transaction checking executor ownership, approved revision, dependency completion, scope overlap, account pin, local safety caps, then writing attempt generation/idempotency key/lease and event together. A lease is a local recovery timer, not proof that a provider stopped. No in-memory request semaphore is capacity evidence.

Node's account-pinned `LightSprintJobsAdapter` is the sole caller of `lightsprint_api` through the native MCP URL. For fresh work, use documented operations only: `POST /api/tasks` with `{title,scope:"stack",stackId}`, `PATCH /api/tasks/{taskId}` to save the bounded task packet, then `POST /api/tasks/{taskId}/lightsprint-agents/{provider}` with `{branchName,autoMerge:false}`. Persist each returned remote ID before the next call. `autoMerge` is always false. No direct REST credentials, undocumented endpoint, hidden browser call, model catalog, quota query, capacity query, or provider failover.

A create/launch timeout is **ambiguous**, never an automatic retry. Persist the operation phase and any known task ID; reconcile a known task with documented task/agent reads before proceeding. If creation's response was lost and no unique remote task can be proved, stop for operator reconciliation. The remote API exposes no idempotency contract. Keep the account pinned through launch, status, chat, and cancellation.

The current published chat shape is `POST /api/agent-sessions/{id}/chat` with `{content}`; the supplied handoff and Snooze adapter use `{message,clientMessageId}`. Treat resume as disabled (`resume_schema_unverified`) until a live MCP contract test settles this discrepancy. Once verified, persist a local continuation ID and bounded retry count before sending; because upstream idempotency is undocumented, never replay after an ambiguous send. Poll documented session status; idle/completed/failed alone does not prove task completion or release scopes. Validate a saved artifact against the approved output contract, then mark complete and release. Provider-confirmed cancel or explicit audited manual ownership resolution are the only other release paths.

Task lifecycle: `draft -> queued -> reserved -> starting -> running -> awaiting_output -> validating -> complete`; `queued|retry_due -> reserved` retries; operator may `held`; validation or policy failure becomes `blocked`; bounded recoverable failure may become `retry_due`; cancellation is `cancel_pending -> cancelled` only after confirmation. An attempt can be `reserved|starting|running|awaiting_output|validating|ambiguous|blocked|complete|cancel_pending|cancelled|failed`. Stale generations' artifacts are quarantined. Unknown, idle, unavailable, or failed observations never silently imply completion or release.

## Quota, capacity, recovery, and administration

LightSprint has no documented remaining-credit or worker-capacity endpoint in the reviewed schema. Initialize both as unknown. Unknown quota blocks by default; an operator may enable Snooze's explicit `allow_unknown_quota` policy, which permits a bounded attempt without claiming credit availability. HTTP 402/429 are reactive failure signals and can trigger cooldown; they do not yield a balance. Treat `account.capacity` as an operator-set **local ceiling**, not measured provider capacity; start at one per pinned account absent evidence. Never infer slots from successful prompts or Token2OAuth request concurrency.

Run initially on one Token2OAuth host with multiple scheduler/monitor processes coordinating via the local SQLite file and its transactional locks. This is durable single-host multi-process scheduling, not multi-host HA: do not put SQLite on an unverified network filesystem or claim cluster-wide exactly-once dispatch. Multi-host availability requires a separately approved transactional server database/leader design.

After restart, scan unreleased attempts, re-observe known session IDs, and reconcile known task IDs before recovery. Unknown provider state, auth loss, expired lease, or missing artifact holds scope and raises an incident; no blind reassignment. Bound resume to operator policy (maximum two recoveries, exponential backoff), with dispatch pause/emergency stop honored. Reuse Snooze's persistent event cursor and outbox: delivery is at-least-once with stable delivery IDs; receiver deduplicates; acknowledgment is not resolution, which requires verified state-change evidence. With no configured notifier, keep incidents in the durable inbox.

Expose admin queue, task/attempt detail, event cursor, account binding/health, policy revision, pause/emergency stop, incident acknowledge/resolve, and explicit reconciliation. Account labels shown in UI/logs should be configured privacy-safe aliases; internal stable IDs are not credentials. Persist only allowlisted status fields and error classes. Keep Token2OAuth's telemetry bounded/in-memory for request latency/outcomes; correlate by assignment/task/attempt IDs, but never persist prompts, MCP bodies, bearer tokens, or raw provider errors.

## Ownership and implementation increments

1. Vendor/pin Snooze under `supervisor/snooze/`, record upstream SHA/license, isolate DB/config, and prove standalone Snooze tests/default state are unchanged.
2. Implement the Node IPC client/router and DTO validation in `src/supervisor-bridge.ts` and `src/supervisor-api.ts`; `server.ts` only mounts it. Python socket entrypoint owns bridge serving and existing SQLite modules under `supervisor/`.
3. Implement Node-only account-pinned provider calls in `src/providers/lightsprint-jobs.ts`; do not reuse Snooze's direct-token adapter. Conformance tests cover only published MCP operations. Gate resume pending the chat schema check.
4. Add isolated admin rendering in `src/supervisor-ui.ts`; minimally mount it from `ui.ts`. Provider/inbox UI must not share bridge, scheduler, or adapter files.
5. Start in `shadow`/read-only observation, reconcile existing sessions, then require operator handover with no unreconciled active attempts before `snooze` owns dispatch. Keep standalone Snooze's external-managed/shadow/snooze modes and project database semantics unchanged.

Contract tests: schema bounds and DAG cycle/path rejection; duplicate idempotency returns one assignment; concurrent reservations cannot overlap scopes or exceed local caps; task/event/outbox writes are atomic; revision conflicts reject stale approval; account pin survives errors; ambiguous launch/chat is never duplicated; expired leases do not release ownership; old-generation artifacts quarantine; unknown quota/capacity remain unknown; IPC rejects missing/wrong bearer; secrets and prompts never enter SQLite/events/logs; resume stays disabled until schema fixture passes; outbox deduplicates delivery and separates ack/resolution; standalone Snooze CLI/state regression suite passes.

## Evidence and limitations

R01 and R04 reports are at `origin/research/t2o-r01-lightsprint-20261010` and `origin/research/t2o-r04-clients-auth-20261010`. Snooze evidence is its `TaskRepository.reserve/update_attempt/release`, `Scheduler.tick`, `Monitor`, `EventFeed`, `Outbox`, and LightSprint adapter on the stated baseline. Token2OAuth evidence is `src/store.ts`, `src/server.ts`, `src/provider-capabilities.ts`, `src/telemetry.ts`, and `src/ui.ts` on `origin/main`.

Official LightSprint interface reference (verified 2026-10-10): https://app.lightsprint.ai/docs/mcp/ . Fresh task creation/launch is documented. Exact model selection, quota balance, live agent capacity, and upstream idempotency are undocumented in the reviewed surface. Chat request schema is contradictory across the reviewed material; existing-session LightSprint resume is therefore a gated capability, not claimed as currently verified. The existing Snooze adapter's model/reasoning launch fields likewise do not match the published launch schema and must not be copied as-is.
