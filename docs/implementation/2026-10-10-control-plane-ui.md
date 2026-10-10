# Token2OAuth × Snooze control-plane UI

Implemented a standalone typed renderer in `src/supervisor-ui.ts`. It accepts an explicit snapshot of provider/account/workspace/worker hierarchy, capacity and quota observations, jobs, tasks, workers, events, inbox, supervisor/orchestrator health, optional measured series, and loading/error state. It emits a self-contained, script-free HTML document intended for a later authenticated server mount; this change does not mount routes or add operational writes.

## Design and critique

The visual direction is a cloud workforce command desk: cool paper and slate-blue surfaces, ink typography, restrained copper for warnings, and blue for supplied capacity. Navigation stays in a narrow responsive rail; the main canvas gives workforce distribution the strongest visual weight, with jobs/dependencies, measured history, timeline, inbox, and workers alongside it. Provider → account → workspace → worker is a native `<details>/<summary>` hierarchy, retaining keyboard operation without JavaScript. Native focus indicators, contrast-minded color pairing, small-screen layout, and reduced-motion rules are included.

Critique before implementation: the existing Token2OAuth admin UI is a dark, dense form-and-card console with uppercase micro-labels and decorative gradients. Reusing it would blur operational ownership and reproduce its visual noise. This module instead distinguishes measured state from missing observations, avoids action buttons without a real endpoint, and uses one nested distribution view rather than another generic metric-card grid. Inline CSS is self-contained like the current server-rendered pages; the module adds no scripts, fonts, assets, or external requests.

## Data and safety behavior

- Capacity/quota meters render only when both values are finite and the denominator is positive; exact used/limit values remain visible. Missing or unusable denominators say “Unknown denominator.”
- Snapshot-provided time, health, work, inbox, events, and series are the only rendered observations. Missing fields are described as unknown/unavailable; there is no generated clock, animation, synthetic traffic, or inferred provider quota.
- Event search/severity/pause controls use a GET form and renderer options, filtering only the bounded in-memory snapshot provided by the integration. Raw disclosure uses the existing bounded `telemetry.redact` sanitizer before HTML escaping.
- Lists are capped (default 60, hard maximum 200); empty, loading, and error states are explicit. No pause/resume/retry/write control was invented.

## Verification

`test/supervisor-ui.test.mjs` covers nested native disclosures, known versus unknown denominators, escaping and raw-secret redaction, local filters, bounded records, empty/loading/error rendering, absence of fabricated controls/traffic, and supplied time-series values. Run `npm test` for TypeScript compilation and the complete Node test suite.

## Limits

This is a UI module only. `src/server.ts` and `src/ui.ts` were not changed; a later integration must map authoritative supervisor data and query parameters into this renderer, provide authenticated routing/CSP policy, and decide which operational endpoints exist. No browser preview or screenshot is available from this isolated worktree, and no live supervisor/provider execution was performed.
