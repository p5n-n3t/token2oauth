# Worker observation contract correction

Reviewed the merged source at `origin/codex/unified-platform-20261010` commit `d951ea2`, including `supervisor/snooze/jobs.py` and the bounded transcript projection in `src/providers/lightsprint-jobs.ts`.

The Python registry stores `dispatchAt` as Unix epoch seconds and accepts `assistantAt` only as a numeric timestamp in the same unit. The worker now treats numeric timestamps as seconds, converts parseable provider date strings with `Date.parse(value) / 1000`, and rejects invalid durable dispatch timestamps. Accepted observations preserve the recognized session status (such as `idle`); the registry decides completion from the presence of fresh text and numeric time.

The provider adapter returns a recent-message projection with `latestAssistantIndex` and `latestAssistantComplete`; individual projected messages also carry `complete`. The worker now reads only that pointed-to newest assistant message. It requires both projection and message completeness, a valid timestamp at or after dispatch, and a supported text content shape. A stale, omitted, oversized, or incomplete newest answer yields an accepted observation without text/time so Python can poll again; the worker never falls back to an older assistant answer.

Regression coverage uses Python-shaped claim envelopes and verifies stale answer exclusion, all combinations of incomplete latest-message indicators, numeric-second receipts from ISO assistant timestamps, and invalid dispatch rejection. Existing pinned-account ownership/eligibility checks, single-send behavior, ambiguous no-replay handling, and idempotent result receipt retry remain unchanged. No runtime, bridge, job-submit, Python registry, or live-service files were edited, and no upstream calls were made.

## Verification

- `node --test test/job-worker.test.mjs`: 10 passed.
- `npm test`: TypeScript build passed; 178 tests passed and one unrelated existing runtime fixture failed in `test/supervisor-runtime.test.mjs` (`private runtime composes the real Python Unix bridge and keeps jobs across restart`, HTTP 400 at the `job_submit` call). The failing fixture exercises unchanged runtime/job-submit/Python paths, not this worker change.

## R36 assistant output completeness follow-up

Based on integration head `09082f3458c92ceae1ce66ab8b7cf5b727b96a6c`, the worker no longer applies the 2,048-character metadata limit to assistant output. It preserves the complete newest assistant text when its UTF-8 encoding is at most 32 KiB and omits both `assistantText` and `assistantAt` when the byte bound is exceeded; this prevents Python's completion marker check from accepting a truncated prefix. The bound is measured in encoded bytes, so multibyte text is accounted correctly. Existing ID/instruction limits remain separate.

Regression tests verify full retention beyond 2,048 characters and oversized multibyte output rejection without assistant completion evidence. `node --test test/job-worker.test.mjs` passed (12/12). `npm test` compiled successfully and passed 187/188 tests; the one failure remains the unrelated existing runtime fixture `private runtime composes the real Python Unix bridge and keeps jobs across restart` (`Supervisor bridge operation failed`, HTTP 400, at `test/supervisor-runtime.test.mjs:42`).
