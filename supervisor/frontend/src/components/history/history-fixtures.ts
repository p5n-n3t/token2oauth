import type { HistoryMetric, HistoryReportResponse } from "../../lib/history-types";

function metric(value: number | null, unit = "events", state = value === null ? "unavailable" : "available"): HistoryMetric {
  return { value, unit, source: "Snooze event log", coverage: { observed: value === null ? 0 : 3, eligible: value === null ? null : 3, missing: value === null ? null : 0 }, state };
}

export function makeHistoryResponse(overrides: { events?: number; inputTokens?: number | null; queryMs?: number } = {}): HistoryReportResponse {
  const events = overrides.events ?? 4;
  const summary: Record<string, HistoryMetric> = {
    events: metric(events), task_outcomes: metric(2, "validated tasks"), validated_throughput: metric(2, "validated tasks"),
    queue_latency_p50: metric(42, "seconds"), queue_latency_p95: metric(91, "seconds"), run_duration_p50: metric(83, "seconds"), run_duration_p95: metric(150, "seconds"),
    retry_attempts: metric(0, "attempts"), retry_rate: metric(0, "ratio"), validation_failures: metric(1, "attempts"), validation_failure_rate: metric(.25, "ratio"),
    recoveries: metric(1, "recovery events"), time_to_recovery_p50: metric(25, "seconds"), input_tokens: metric(overrides.inputTokens === undefined ? null : overrides.inputTokens, "tokens"),
    output_tokens: metric(1500, "tokens"), reasoning_tokens: metric(null, "tokens"), cache_read_tokens: metric(200, "tokens"), cache_write_tokens: metric(40, "tokens"),
    observed_cost: { ...metric(null, "mixed currency"), source: "provider-reported cost facts" }, estimated_cost: { ...metric(null, "currency unavailable"), source: "catalog/API-equivalent estimate facts" },
    cache_efficiency: metric(.12, "ratio"), concurrency_peak: metric(2, "attempts"), owned_time_seconds: metric(30, "seconds"), idle_time_seconds: metric(null, "seconds"), historical_utilization: metric(null, "ratio"),
  };
  const zeroHours = Array(24).fill(0) as number[];
  const hoursPresent = Array(24).fill(true) as boolean[];
  const day = "2026-10-06";
  return {
    filters: { project_id: "current-snooze", from_utc: "2026-10-01T00:00:00.000Z", to_utc: "2026-10-08T00:00:00.000Z", timezone: "UTC", accounts: [], models: [], efforts: [] },
    bounded_rows: 10000,
    native: {
      summary,
      series: [
        { date: "2026-10-05", events: events - 1, validated: 1, input_tokens: null, output_tokens: 600, observed_cost: null, estimated_cost: null, observed_costs: [{ currency: "USD", value: 1.25 }], estimated_costs: [{ currency: "USD", value: 2.1 }] },
        { date: day, events: 1, validated: 1, input_tokens: null, output_tokens: 900, observed_cost: null, estimated_cost: null, observed_costs: [{ currency: "EUR", value: 1.5 }], estimated_costs: [] },
      ],
      heatmap: [{ date: "2026-10-05", hours: zeroHours.map((value, index) => index === 10 ? 3 : value), hours_present: hoursPresent }, { date: day, hours: zeroHours.map((value, index) => index === 13 ? 1 : value), hours_present: hoursPresent }],
      hour_of_week: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24, events: index === 34 ? events : 0 })),
      breakdowns: {
        projects: [{ project_id: "current-snooze", folder: "/work/snooze", event_count: events, attempt_count: 2, usage_count: 2, input_tokens: null, output_tokens: 1500, observed_cost: null, estimated_cost: null, observed_costs: [{ currency: "USD", value: 1.25 }, { currency: "EUR", value: 1.5 }], estimated_costs: [{ currency: "USD", value: 2.1 }] }],
        accounts: [{ id: "night-account", event_count: events, attempt_count: 2, usage_count: 2, input_tokens: null, output_tokens: 1500, observed_cost: null, estimated_cost: null, observed_costs: [{ currency: "USD", value: 1.25 }], estimated_costs: [] }],
        models: [{ id: "codex-gpt", event_count: 2, usage_count: 2, input_tokens: null, output_tokens: 1500, observed_cost: null, estimated_cost: null, observed_costs: [], estimated_costs: [] }],
        requested_models: [{ id: "requested-model", event_count: 2, usage_count: 0, input_tokens: null, output_tokens: null, observed_cost: null, estimated_cost: null, observed_costs: [], estimated_costs: [] }],
        confirmed_models: [{ id: "confirmed-model", event_count: 1 }], efforts: [{ id: "high", event_count: 2 }],
        tools: [{ id: "read_file", event_count: 1, usage_count: 0, tool_call_count: 1, input_tokens: null, output_tokens: null, observed_cost: null, estimated_cost: null, observed_costs: [], estimated_costs: [] }],
      },
      concurrency: [{ at: 1791240000, active: 1, attempt_id: "attempt-real-1" }, { at: 1791326400, active: 2, attempt_id: "attempt-real-2" }],
      top_sessions: [{ session_id: "session-source-9f2", input_tokens: 800, output_tokens: 900, model: "codex-gpt", observed_costs: [{ currency: "USD", value: 1.25 }] }],
      coverage: {
        native_events: { observed: events, eligible: events, missing: 0, state: "available" },
        usage: { observed: 2, eligible: null, missing: null, state: "partial", completeness: "Eligible source sessions are not independently enumerated.", sources: ["agentsview"] },
        historical_capacity: { observed: 0, eligible: null, missing: null, state: "unavailable", completeness: "No eligible capacity snapshot total." },
        concurrency: { observed: 2, eligible: 2, missing: 0, state: "available" }, truncated: false, truncation: { events: false, tasks: false, facts: false, attempts: false },
      },
      sources: [{ id: "agentsview", version: "2.4.1+abc123 (API 1)", window: { from: 1791158400, to: 1791244800 }, facts: 2, observed_cost_sources: ["provider_reported"], estimated_cost_sources: ["catalog_estimate"] }],
      query_ms: overrides.queryMs ?? 7.4,
    },
  };
}
