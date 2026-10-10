# Focused adapter and dispatch-fencing review

**Assignment:** `T2O-R16-20261010`

**Reviewed refs:** Token2OAuth `feat/t2o-search-adapters-20261010` (`6f8090e`, compared with `origin/main` `7d084c6`); Snooze `fix/snooze-dispatch-fencing-20261010` (`6130292`, based on `codex/snooze-command-centre` `1e2b56e`).

## Finding

### Blocker — a cancellation racing final dispatch can still launch the provider

`TaskRepository.dispatch_fence` at `snooze/tasks.py:186-200` verifies active ownership, project ownership, policy revision, pause/stop, account authorization/configuration, and occupancy, but never verifies the attempt phase. `ControlService` can persist `cancel_pending` at `snooze/control.py:77-84`; it checks for an active attempt but not for an existing session before updating the attempt. If cancellation lands after the scheduler sets `starting` and before `snooze/scheduler.py:202-207` enters the final fence, the fence accepts the still-active `cancel_pending` row and launches anyway. The later `running` update overwrites the cancellation state.

**Reproduction:** after the scheduler writes `starting`, interleave `repo.update_attempt(attempt_id, 'cancel_pending')` before `dispatch_fence`; the reviewed branch launched once and ended with the attempt `running`. This models the persisted state change made by the cancel control path.

**Minimal regression:** arrange that interleaving and assert no launch occurs, the cancellation state is retained, and the slot is not released. The final fence should reject an attempt outside the phase expected for that mutation; the pre-I/O release path must continue refusing `cancel_pending` ownership.

## Checks that passed

- Snooze's final fence holds `BEGIN IMMEDIATE` across the provider launch/resume call. Occupancy snapshots exclude the attempt itself for account, project, global, and model limits. Recovery rechecks current account authorization/configuration and policy, and preserves ambiguous ownership; `abandon_pre_io` only releases `reserved`/`starting` attempts with no session.
- Token2OAuth's adapter uses fixed provider origins/routes and `redirect: "error"`; bounds request/response size, result count, and timeout; and emits generic errors without credentials, request URLs, provider bodies, or query text. It makes one fetch only and reports post-send failures as outcome-unknown. No adapter security blocker found in the reviewed code.
- Focused tests: Token2OAuth build plus adapter tests passed (14 tests); Snooze scheduler/task tests passed (35 tests). The Snooze cancellation race above is not covered by those tests.

## Review boundary

No implementation edits, live provider requests, paid operations, deployments, or merges were made. Adapter tests use injected fetch responses; they do not establish live provider compatibility. Future adapter wiring must preserve the `unknown` request outcome and avoid retrying it.
