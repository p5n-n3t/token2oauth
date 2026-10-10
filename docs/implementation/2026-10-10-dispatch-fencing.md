# Dispatch fencing and recovery revalidation

**Date:** 2026-10-10

**Base:** `origin/codex/snooze-command-centre` at `1e2b56e2987e1dc201716a17805b05fbf5286623`

## Changes

`TaskRepository.dispatch_fence` opens a SQLite write transaction and verifies that the attempt still owns an active slot, Snooze still owns the project, the policy revision is current, pause/emergency-stop allow the operation, and the account remains authorized and configured. The transaction stays open through one provider launch or resume call, serializing a committed pause/stop or account change with that call. A policy change after reservation now blocks launch. A writer that tries to persist a stop after the final fence waits until an already-fenced provider call returns; the stop is not acknowledged ahead of that call.

Immediately before I/O, the scheduler evaluates the fresh account configuration and snapshot with the current policy. This rechecks enablement, health, cooldown, quota expiration/reserve, unknown-quota policy, capacity, project/global limits, and model limits. Occupancy counts exclude the attempt being dispatched, so its reserved account/project/global/model slot does not reject its own launch or recovery.

A rejected launch fence can release only a local `reserved`/`starting` attempt with no session, and records that provider I/O never started. Ambiguous or session-owning attempts cannot use this path. Recovery persists an ambiguous state and stable resume message ID before provider I/O, then performs the final fence. An uncertain result or a gate change at that point remains ambiguous; later cycles reconcile ownership before any further resume mutation.

## Verification

- `python3 -m unittest tests.test_scheduler tests.test_tasks -v` — 35 tests passed.
- `python3 -m unittest discover -s tests -q` — 178 tests passed.
- Regression cases cover pause, emergency stop and revision changes after reservation; a stop attempting to persist during an already-fenced call; disabled, unauthorized and quota-exhausted recovery accounts; ambiguous resume reconciliation; own-slot accounting; and refusal to release ambiguous ownership.
- The adapter tests use fakes. No provider launch, paid call, deployment, or merge was performed.

## Limits

Quota revalidation uses the currently configured quota override and reserve; it does not create a durable usage ledger or turn unknown provider usage into a bounded budget. Explicit acknowledgement of unbounded budgets and the separate audited operator ownership-resolution action remain outside this assignment. A recovery fence rejected after its durable resume marker may require reconciliation even though no new provider request was sent. No UI, transport, control endpoint, packaging, or standalone Trump observer files were changed.
