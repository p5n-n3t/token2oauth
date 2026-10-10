# Dashboard usage reporting

## Implementation

The admin projection now carries the optional task usage contract into task rows and the matching registered session worker. It validates finite nonnegative values, prompt-count integers, positive budget maxima, bounded text, the known status source, and the provisional marker. Missing or malformed numeric observations are omitted. The model remains a separate task status observation (`modelReported`), rather than being treated as part of the usage DTO.

The workforce view shows the task's provider-reported USD increase, any reported session total, model, prompt count, status source, observation time, funding source, and sandbox tier. A provider session budget bar is rendered only when both numeric values are present and the maximum is positive; its unit remains “not reported.” Account totals sum only reported USD deltas and deduplicate task-generation identities. Coverage shows how many generations have a cost observation. Remaining quota stays unknown; the account view notes that workspace billing may be shared.

No provider slots, account capacity, quota, or credit-to-USD conversion is inferred. This UI does not change worker startup, bindings, or provider calls.

## Verification

The final focused check `npm run build && node --test test/supervisor-ui.test.mjs test/supervisor-runtime.test.mjs` passed (16 tests). It covers mapping including the separate reported model field, deduplication, coverage, safe rendering, and missing-value behavior. The full `npm test` suite (194 tests) passed earlier in this work; it was not repeated after the final model-field separation. No live provider calls or browser preview were used.
