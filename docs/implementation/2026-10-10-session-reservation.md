# T2O-R35 session reservation

Existing-session jobs used to apply the account's `localCapacity` limit without checking occupancy of the pinned session itself. With capacity above one, different jobs (including jobs in different projects or accounts) could therefore enqueue concurrent work against one session.

The registry now checks active session occupancy inside the same SQLite `BEGIN IMMEDIATE` transaction that creates the reservation, operation, and generation. It checks all `job_tasks` by session ID, independent of assignment, project, or account, and checks live Snooze attempts sharing the database. `reserved`, `starting`, `running`, `awaiting_output`, `ambiguous`, and `cancel_pending` retain the lock; completed tasks leave the active set. Operation claims repeat the session check before handing work to a worker. Existing account capacity, scope checks, idempotency, and generation fencing remain in place.

Account registration now rejects changes to a busy session's account/model/workspace identity, including removal, tuple changes, or adding an already-busy session to another account. Re-registering an unchanged, already-present tuple remains allowed for ordinary account metadata refreshes.

SQLite-backed tests cover concurrent claims for one session across accounts and projects (including two jobs on one account with capacity four), ambiguous reservation across registry restart, completed release, and cancellation-pending retention. Verification: `python3 -m unittest tests.test_jobs -v` passed all 18 focused tests, and `python3 -m unittest discover -v` passed all 213 Python tests from `supervisor/`.
