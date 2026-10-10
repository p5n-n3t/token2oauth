# Worker observation contract correction

Reviewed the merged source at `origin/codex/unified-platform-20261010` commit `d951ea2`, including `supervisor/snooze/jobs.py` and the bounded transcript projection in `src/providers/lightsprint-jobs.ts`.

The Python registry stores `dispatchAt` as Unix epoch seconds and accepts `assistantAt` only as a numeric timestamp in the same unit. The worker now treats numeric timestamps as seconds, converts parseable provider date strings with `Date.parse(value) / 1000`, and rejects invalid durable dispatch timestamps. Accepted observations preserve the recognized session status (such as `idle`); the registry decides completion from the presence of fresh text and numeric time.

The provider adapter returns a recent-message projection with `latestAssistantIndex` and `latestAssistantComplete`; individual projected messages also carry `complete`. The worker now reads only that pointed-to newest assistant message. It requires both projection and message completeness, a valid timestamp at or after dispatch, and a supported text content shape. A stale, omitted, oversized, or incomplete newest answer yields an accepted observation without text/time so Python can poll again; the worker never falls back to an older assistant answer.

Regression coverage uses Python-shaped claim envelopes and verifies stale answer exclusion, all combinations of incomplete latest-message indicators, numeric-second receipts from ISO assistant timestamps, and invalid dispatch rejection. Existing pinned-account ownership/eligibility checks, single-send behavior, ambiguous no-replay handling, and idempotent result receipt retry remain unchanged. No runtime, bridge, job-submit, Python registry, or live-service files were edited, and no upstream calls were made.

## Verification

- `node --test test/job-worker.test.mjs`: 10 passed.
- `npm test`: TypeScript build passed; 178 tests passed and one unrelated existing runtime fixture failed in `test/supervisor-runtime.test.mjs` (`private runtime composes the real Python Unix bridge and keeps jobs across restart`, HTTP 400 at the `job_submit` call). The failing fixture exercises unchanged runtime/job-submit/Python paths, not this worker change.
