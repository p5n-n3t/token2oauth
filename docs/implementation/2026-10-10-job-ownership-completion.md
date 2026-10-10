# T2O-R41 job ownership and completion

Scoped assignment reads now match the stored owner principal and client ID exactly. Supplying either trusted filter requires both stored fields to match, so NULL legacy/admin rows and rows belonging to another client are not wildcards. Direct `JobRegistry` calls with both filters omitted remain the explicit local-admin boundary; the private bridge's `/admin/api/v1` read routes retain that behavior, while public `/v1` results and cancellation require at least one trusted owner/client header and return 403 when both are absent. Scoped missing or mismatched records return 404.

Result handling now writes the final task state before checking whether all assignment tasks are complete. A queued, approved parent transitions to complete once, with one revision increment and a completion event. A cancelled or held parent is not overwritten, and repeated operation receipts return through the existing idempotency path without changing the parent revision.

The assignment status DTO exposes persisted task `dispatchAt`, `releasedAt`, and reported model values. `providerStatus` is persisted only from an `observe_session` result; accepting the chat request alone does not fabricate an observed status or overlap claim. The schema upgrade adds this optional field for existing SQLite databases.

SQLite-backed tests cover legacy-row and cross-client isolation through the HTTP bridge, unfiltered admin access, missing-scope denial for reads/cancellation, two-task dependency completion across restart, idempotent completion receipts, and timeline fields before and after provider observation. Verification: the focused bridge/registry suite passed 25 tests, and `python3 -m unittest discover -v` passed all 216 Python tests from `supervisor/`.
