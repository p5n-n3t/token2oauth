# T2O-R21 existing-session job runtime

Branch `feat/t2o-job-runtime-20261010`, based on R14 commit `24d96d3` with R11 Snooze source imported for integration tests. This increment makes the Python registry execute bounded work only in registered existing sessions; it does not launch new provider sessions.

## Implemented

- Added authenticated private `POST /v1/accounts` registration for stable account IDs, enabled/authorized/health/quota signals, local capacity, explicit unknown-quota acknowledgement, and registered session/model/workspace tuples. No credentials are accepted or stored. Unknown quota blocks dispatch unless the account registration explicitly acknowledges it. One-account assignments are valid; ordinary text tasks need no artifact hash pair.
- Claims now carry the private chat payload needed by Node: operation/attempt/generation/account plus session, instructions, client message ID, durable dispatch timestamp, expected marker, and optional task/stack/provider references. Account/session authorization and quota are checked again immediately before claim. Global and per-job dispatch is capped at three workers by default; account capacity defaults to one. These are local ceilings, not provider quota or rate-limit claims.
- Existing-session execution sends one `chat_session`, then schedules delayed `observe_session` polls with bounded backoff. Idle without a fresh assistant message is not completion. Python accepts only allowlisted result fields, rejects stale timestamps, bounds UTF-8 output bytes, requires the expected marker, stores verified output privately, and only then completes the task and unlocks DAG dependents.
- The registry shares the Snooze SQLite connection. Active assignments reserve shadow attempt rows so both this runtime and Snooze's existing scheduler see overlapping scopes inside SQLite transactions. Task/job generations fence late results. Expired chat claims and cancellation after dispatch remain ambiguous and keep ownership; no blind retry or ownership release occurs. Snapshots/events omit instructions; result and assignment reads can be filtered by trusted principal/client headers.
- Added private results, cancellation, and account registration bridge routes. The Unix socket and state-directory protections remain in place.

## Verification

- Focused registry/bridge suite: 20 tests passed. Includes 35 tasks across 9 registered accounts under the 3-worker cap, one-account execution, scope conflicts across jobs and Snooze attempts, dependency unlocking after validated output, stale assistant rejection, account revalidation, cancellation generation fencing, restart/ambiguous-claim handling, ownership filters, bridge authentication, and private claim payloads.
- Full imported Snooze suite: 186 of 187 tests passed. The one existing integration-harness failure is `test_installer.InstallerTests.test_help_and_shell_syntax`: the imported `supervisor/` source tree has no `install.sh`, which that test invokes from its working directory. No runtime tests failed.
- `git diff --check` passed.

## Remaining boundary

Fresh launches, coding/artifact outputs, automated remote cancellation, and an audited manual resolution path for ambiguous remote ownership remain unsupported. A cancelled or ambiguous attempt intentionally retains its Snooze ownership row until a separate reconciliation/resolution mechanism exists. The Node worker/adapter is owned by another assignment and must consume this claim DTO, return the allowlisted observation result, and provide trusted `X-Owner-Principal` / `X-Client-Id` headers before exposing user-facing APIs. No provider calls were made.
