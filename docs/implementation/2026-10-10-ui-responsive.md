# Supervisor control-plane responsive UI follow-up

## Changes

- Reworked grid sizing and mobile navigation so intrinsic content no longer forces the page wider than the viewport. Disclosure summaries and long IDs can wrap; filters and controls stay within their available width. The nav retains horizontal scrolling where its links exceed the phone width, and the document itself is not globally clipped.
- Replaced implementation-facing copy with operational language while preserving an explicit “Limit not reported” state when usage lacks a known denominator.
- Normalization now recognizes the Python assignment-list receipt shape (`assignments` with `assignmentId`, `state`, `revision`, and `taskCount`) and renders those receipts as jobs. It does not infer provider groups, task details, account capacity, or quota from assignment data.
- Left the admin API/runtime, nonce-protected polling, and existing responsive accessibility preferences unchanged.

## Verification

`npm test` passed: TypeScript build and all 172 tests. Added renderer regressions for mobile width containment, long identifiers, ordinary copy, and the real assignment receipt shape. `git diff --check` passed.

No isolated browser preview was available for this `/tmp` worktree, so the reported 390×844 scroll width was not remeasured in a live browser and there is no screenshot proof. CSS and renderer regressions pass; browser confirmation remains outstanding.
