# Doctor

**Integrated in 0.2.0:** `token2oauth doctor` collects a real snapshot via
`src/doctor-runtime.ts` (local `/healthz`, state, decryptability of each stored
credential without revealing it, last probe results, stored tool inventories,
read-only `systemctl`/`tailscale serve status --json`; `--live` adds one
initialize probe and one inventory refresh; `--public` fetches OAuth metadata
through the public URL and checks ChatGPT's callback is registered).
`--repairs` prints previews only; a missing Funnel mount points at `token2oauth
lifecycle up`. The dashboard Diagnostics page runs the same checks on request.

## Original API notes

`src/doctor.ts` provides deterministic diagnosis and repair previews for a
coordinator or future CLI integration. It consumes caller-supplied snapshots;
it does not read the host, call the gateway, change state, or execute repairs.
No CLI route or command is wired by this module.

## API

After `npm run build`, import `diagnoseDoctorSnapshot` and
`planDoctorRepairs` from `dist/doctor.js`.

~~~ts
import { diagnoseDoctorSnapshot, planDoctorRepairs } from "./dist/doctor.js";

const report = diagnoseDoctorSnapshot(snapshot);
const previews = planDoctorRepairs(snapshot, [
  { action: "set-upstream-url", value: "https://provider.example/mcp" },
]);
~~~

The snapshot has seven explicitly checked stages: `process`, `config`,
`credentials`, `upstream`, `oauth`, `tools`, and `funnel`. Missing observations
are `unverified`. A report is `healthy` only when every stage has enough
explicit passing evidence. In particular, upstream health requires a successful
MCP initialize probe and tool health requires a successful `tools/list` probe.
An empty but successful tools list is reported as a warning, not a failed probe.

Findings have stable IDs, severity, bounded evidence, and a typed action. The
doctor covers local process/listener failures; required configuration fields;
unavailable or HTTP 401 credentials; quota/rate-limit signals; upstream network
failures and timeouts; OAuth issuer, resource, and redirect mismatches;
`tools/list` failures or empty results; and duplicate exact Funnel paths routed
to different targets. A root mount alongside `/token2oauth` is valid and is not
classified as a collision. Raw credential material and upstream error text are
not returned in findings.

Credential cooldowns are compared with `credentials.observedAt` from the same
snapshot. A cooldown without an evaluation timestamp remains unavailable rather
than being assumed expired.

## Repair previews

`planDoctorRepairs(snapshot, candidates)` accepts only these typed actions:

- `set-upstream-url` — a plain HTTP(S) URL, only when the current upstream URL
  is invalid and that field has been checked.
- `set-public-base-url` — a plain HTTP(S) URL matching the explicitly supplied
  expected OAuth issuer, when an OAuth mismatch is present.
- `add-funnel-path-mount` — the configured missing path to the checked local
  listener port, only when Funnel is enabled and there is no collision. The
  preview is additive and preserves existing mounts.
- `enable-account` — one existing account, only after an explicit request and
  confirmation that stored material is available.

Each result lists preconditions and includes a before/after preview only when
all preconditions pass. A blocked preview is not an instruction to bypass its
checks. The planner does not accept shell strings, credential values, arbitrary
file paths, process controls, reset operations, or global Tailscale changes.
It has no execution function; a coordinator must obtain any required operator
approval and apply an accepted operation through existing application paths.

## Integration points and limits

The existing `StateStore`, `CredentialPool.probeAll()`, OAuth metadata routes,
MCP proxy, and Tailscale status command are possible snapshot sources. Callers
must collect those observations and set each stage's `checked` flag only after
performing the corresponding check. `doctor.ts` is intentionally not wired to
those services or to the CLI in this task. It cannot infer live health, provider
quota, Funnel status, or OAuth interoperability from configuration alone, and
it does not replace an actual upstream initialize or tool-discovery probe.

The test suite exercises the rule outcomes and planner preconditions with
`node:test`; run it with `npm test`.
