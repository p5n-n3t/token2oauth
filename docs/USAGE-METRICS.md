# Usage metrics normalization

`src/usage-metrics.ts` provides a pure normalization and aggregation boundary for telemetry. It stores no events, reads no request bodies or credentials, performs no network calls, and ignores fields it does not recognize.

## API

- `normalizeUsageEvent(input)` returns one normalized record. A valid HTTP status infers success for 2xx and error otherwise; an explicit boolean `success` takes precedence. Missing or invalid outcome data stays `null`.
- `UsageMetricsAccumulator.record(input)` normalizes and counts one supplied record. `snapshot()` returns overall totals and groups by the sanitized pool, provider, account alias, tool, and model labels.
- `aggregateUsage(iterable, options)` is a convenience for processing a finite iterable through the same accumulator.
- `privacySafeLabel(value)` exposes the label filter for callers that want to apply the same restrictions before building telemetry.

Timestamps may be epoch milliseconds or date strings accepted by `Date.parse`; normalized values are epoch milliseconds. Non-negative finite values are accepted for latency and cost, and token counts must be non-negative integers. Optional token and cost totals stay `null` until at least one record supplies that measure; an observed zero remains zero.

Quota input uses `quotaUsed` and `quotaLimit`. `quota.usedFraction` is `used / limit` only when both values are known and the limit is positive. It is the observed fraction consumed and may exceed 1; it does not mean remaining credit. Missing data, malformed values, or a zero limit yields `null`. Aggregate quota is the mean of supplied, valid fractions and its observation count; it does not estimate an account-wide balance.

LightSprint `session` data is a separate record containing `status`, `stageLabel`, `costUsd`, `budgetUsd`, `createdAt`, `updatedAt`, and `finishedAt`. Session cost and budget remain session fields; they never populate account quota or quota limits. The event's own `costUsd` is likewise an observed usage cost, not account balance.

## Bounds and privacy

Latency percentiles use deterministic reservoir samples: 2,048 retained overall and 128 per group by default. `maxSamples`, `maxGroups`, and `maxGroupSamples` can lower or raise these within hard limits. The accumulator retains at most the configured number of dimension groups (default 100, hard maximum 500); excess label combinations share an overflow group. Percentiles are approximate when the latency observation count exceeds its sample limit. Counts, sums, timestamp bounds, and quota fraction averages include every record, not only sampled latencies.

Source provenance counts are included in each summary. Up to 100 distinct sanitized source labels are retained per summary; additional source labels are counted under `(other)`. Labels are limited to short category-like text and values that look like emails, URLs, credentials, or free-form text are dropped. Integrators should still use stable, non-personal aliases for account labels and must never pass tokens, authorization material, payload bodies, tool arguments, or user identifiers as labels.

Unknown fields such as bodies, headers, and arbitrary error strings are not copied into normalized records. The caller remains responsible for constructing the explicit input from trusted telemetry and for excluding sensitive data before calling this module.

## Telemetry module PR3 integration

This is standalone scaffolding; it does not alter the proxy or the existing pool counters. In telemetry module PR3, create one accumulator per intended reporting window and call `record` at the client-facing MCP request boundary with the outcome, elapsed time, selected pool/provider, a non-personal account alias, tool/model when actually observed, and token/cost/quota fields only when a real upstream source provides them. Record a logical downstream request once; do not treat each upstream failover attempt as a separate client request unless the report explicitly measures upstream attempts. Tag or exclude health probes separately.

Token2OAuth's current credential-pool request/success/failure counters are lifetime account attempt counts: retries and failovers can increment them for one downstream request, and probes update them too. They do not contain latency, token usage, cost, or numeric account quota. Pool cooldown and HTTP 402/429 detection are availability signals, not measurements of remaining provider credit. PR3 should wire this normalizer to its telemetry source rather than infer analytics from those counters.
