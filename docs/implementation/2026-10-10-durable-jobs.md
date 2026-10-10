# R14 durable jobs and private bridge

**Assignment:** T2O-R14-20261010
**Base:** Token2OAuth `origin/main` `7d084c64`
**Contract reviewed:** `design/t2o-unified-contract-20261010`, commit `6f3e3ed`
**R11 source inspected:** `feat/t2o-supervisor-source-20261010`, commit `cea57f1`
**Status:** Partial implementation; no provider calls were made.

## Implemented

- Added a bounded assignment registry with closed request shapes, up to 100 DAG tasks, cycle/dependency checks, scope and instruction bounds, account-ID validation, and `(projectId, idempotencyKey)` deduplication. Direct authorized submissions enter `queued`; the optional admin draft route requires revision-fenced approval.
- Persisted task reservations, immutable per-attempt account selection, generations, and provider-operation outbox rows in one SQLite transaction before returning a claim. Claims are lease bounded. Expired mutating claims become `ambiguous`, hold the assignment, and cannot be requeued. Result replay is idempotent; a conflicting replay is rejected. Fresh work advances through create, patch, packet verification, and launch operation records.
- Added assignment list/snapshot, event cursor, pause/emergency-stop, claim, and result routes on the bridge. Snapshots omit instructions and report model selection, quota, and capacity as unknown/unsupported.
- Added a Unix-domain HTTP server that reads a minimum 256-bit bearer from the inherited auth pipe, checks it on every request, limits JSON bodies, disables request logging, sets the state directory to `0700`, and the socket/database to `0600`. It opens no TCP listener.
- `JobRegistry` uses the copied Snooze `TaskRepository` connection and event table when `snooze.tasks` is present. R11's source branch was fetched and inspected but was not merged into this branch; the standalone fallback was used for R14 unit tests.

## Verification

- R14 focused suite: 12 tests passed, covering durable idempotency, DAG cycles/bounds, reservation/account affinity, pause fencing of new and already-queued operations, operation result replay/conflict, ambiguous lease expiry, secret rejection, bridge bearer enforcement, and filesystem permissions.
- `TaskRepository` integration smoke test passed: the registry shared Snooze's SQLite transaction and event table. The R11 branch's `tasks.py` and `migrations.py` Git blob hashes matched the preserved Snooze source used for this test.
- Existing Snooze Python suite on the preserved workspace checkout: 167 tests passed. This checks the standalone source; it is not an integrated test of the R11 vendor tree plus R14 bridge.
- Token2OAuth has no Python suite on `origin/main`; its Node suite was not run because this change is Python-only.

## Not completed in this increment

The R11 vendor source is not part of this branch; the adapter was smoke-tested against byte-identical Snooze modules, but the combined R11+R14 worktree was not tested. The registry keeps job task state in its own additive tables and does not yet create Snooze `TaskSpec`/attempt rows or apply Snooze scope-overlap and recovery policy. It also does not yet implement account health/quota/session-registration rechecks, output/artifact validation and verified completion, cancellation reconciliation, bounded recovery, inbox acknowledgment/resolution, or a Node worker/admin/MCP route. Consequently this is durable registration and operation-claim plumbing, not end-to-end dispatch or completion proof. The next step is to integrate this narrow branch with R11, map reservations to Snooze task/attempt ownership, and add Node bridge-client tests before enabling any worker.
