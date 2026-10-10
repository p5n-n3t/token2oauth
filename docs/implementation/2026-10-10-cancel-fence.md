# Snooze cancellation-fence repair

## Finding

At base `6130292d86127dd7b984f296a5055654b6b02185`, `dispatch_fence` serialized policy and ownership checks with provider I/O but did not validate the attempt phase or generation. A cancellation persisted after the scheduler changed an attempt to `starting` therefore still passed the fence and launched the provider operation. Separately, a `running` receipt arriving after a cancellation could replace `cancel_pending` in both the attempt and task records.

## Repair

- Dispatch fences now require the expected state and generation and confirm that generation is still current. Launch requires `starting`; recovery’s final resume fence accepts the durable `ambiguous` preparation state for the current generation, while the preflight fence checks the phase it observed.
- Attempt updates preserve `cancel_pending` and `cancelled` against later non-cancellation transitions. They still persist a late provider session receipt, allowing observation and cancellation while keeping ownership reserved.
- A rejected pre-I/O fence does not release a cancellation-owned slot. Recovery still records its ambiguity marker before I/O and only resumes after its final phase/generation fence passes.

## Regression coverage

Added three scheduler interleavings: cancellation between `starting` and the launch fence must prevent launch and retain ownership; cancellation immediately before the post-launch `running` receipt must remain pending while saving the session; cancellation after durable resume preparation must prevent resume and retain ownership. The first two tests failed on the base branch and passed after the fix (red → green); the recovery regression and existing recovery-fence coverage also pass.

## Verification

- Focused cancellation interleavings — 3 passed.
- The repair’s originating Snooze worktree passed `python -m unittest tests.test_scheduler tests.test_tasks` (38 tests) and `python -m unittest discover -s tests` (181 tests).
- The canonical Token2OAuth migration passed `python -m unittest discover -s tests` from `supervisor/` (193 tests).
- `git diff --check` — passed.
- Flow artifact: “Snooze Dispatch and Recovery Fence” is attached to the originating task verification set.

## Migration provenance

The repair was committed in Snooze as `6ddde59035a3fb95bdc2f50a6f99578b68eadc8d`. Its four source/test files were copied into `supervisor/` on Token2OAuth base `cc6d6fb16e271972f5d47f3391ea57e51e4044df`. Before copying, each corresponding target file was byte-compared with its Snooze source at base `6130292d86127dd7b984f296a5055654b6b02185`; all four matched. After copying, all four files byte-match the repaired source. `tests/test_tasks.py` required no tracked content change because it is identical at both bases and after migration.

This verifies the local persistence/fence interleavings with deterministic tests; it does not claim a live-provider cancellation was exercised. No provider calls, deployment, or PR were performed.
