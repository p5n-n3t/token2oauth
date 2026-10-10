export type MetricState = "available" | "partial" | "unavailable" | string;

export interface MetricCoverage {
  observed: number | null;
  eligible: number | null;
  missing: number | null;
}

export interface HistoryMetric {
  value: number | null;
  unit: string;
  source: string;
  coverage: MetricCoverage;
  state: MetricState;
}

export interface CurrencyAmount {
  currency: string;
  value: number;
}

export interface HistorySeriesPoint {
  date: string;
  events: number;
  validated: number;
  input_tokens: number | null;
  output_tokens: number | null;
  observed_cost: number | null;
  estimated_cost: number | null;
  observed_costs: CurrencyAmount[];
  estimated_costs: CurrencyAmount[];
}

export interface HistoryHeatmapDay {
  date: string;
  hours: number[];
  hours_present: boolean[];
}

export interface HistoryHourOfWeek {
  weekday: number;
  hour: number;
  events: number;
}

export interface HistoryBreakdownRow {
  id?: string;
  project_id?: string;
  folder?: string | null;
  event_count: number;
  attempt_count?: number;
  usage_count: number;
  tool_call_count?: number;
  input_tokens: number | null;
  output_tokens: number | null;
  observed_cost: number | null;
  estimated_cost: number | null;
  observed_costs: CurrencyAmount[];
  estimated_costs: CurrencyAmount[];
}

export interface HistoryModelEventRow {
  id: string;
  event_count: number;
}

export interface HistoryEffortRow {
  id: string;
  event_count: number;
}

export interface HistoryBreakdowns {
  projects: HistoryBreakdownRow[];
  accounts: HistoryBreakdownRow[];
  models: HistoryBreakdownRow[];
  requested_models: HistoryBreakdownRow[];
  confirmed_models: HistoryModelEventRow[];
  efforts: HistoryEffortRow[];
  tools: HistoryBreakdownRow[];
}

export interface HistoryConcurrencyPoint {
  at: number;
  active: number;
  attempt_id: string | null;
}

export interface HistoryTopSession {
  session_id: string;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  observed_costs: CurrencyAmount[];
}

export interface HistorySource {
  id: string;
  version: string | null;
  window: { from: number | null; to: number | null };
  facts: number;
  observed_cost_sources: string[];
  estimated_cost_sources: string[];
}

export interface HistoryCoverageEntry {
  observed: number | null;
  eligible: number | null;
  missing: number | null;
  state: MetricState;
  truncated?: boolean;
  completeness?: string;
  sources?: string[];
}

export interface HistoryCoverage {
  native_events: HistoryCoverageEntry;
  usage: HistoryCoverageEntry;
  historical_capacity: HistoryCoverageEntry;
  concurrency: HistoryCoverageEntry;
  truncated: boolean;
  truncation: Record<string, boolean>;
}

export interface NativeHistoryReport {
  summary: Record<string, HistoryMetric>;
  series: HistorySeriesPoint[];
  heatmap: HistoryHeatmapDay[];
  hour_of_week: HistoryHourOfWeek[];
  breakdowns: HistoryBreakdowns;
  concurrency: HistoryConcurrencyPoint[];
  top_sessions: HistoryTopSession[];
  coverage: HistoryCoverage;
  sources: HistorySource[];
  query_ms: number;
}

export interface HistoryReportFilters {
  project_id: string | null;
  from_utc: string;
  to_utc: string;
  timezone: string;
  accounts: string[];
  models: string[];
  efforts: string[];
}

export interface HistoryReportResponse {
  filters: HistoryReportFilters;
  native: NativeHistoryReport;
  bounded_rows: 10000;
}

export interface HistoryFilters {
  fromUtc: string;
  toUtc: string;
  timezone: string;
  accounts: string[];
  models: string[];
  efforts: string[];
}

export const HISTORY_FILTER_VALUE_LIMIT = 20;

export function assertHistoryFilterCardinality(filters: HistoryFilters): void {
  for (const key of ["accounts", "models", "efforts"] as const) {
    if (filters[key].length > HISTORY_FILTER_VALUE_LIMIT) {
      throw new RangeError(`History ${key} filters may contain no more than ${HISTORY_FILTER_VALUE_LIMIT} values.`);
    }
  }
}

export type EngineReportKind =
  | "usage_summary"
  | "usage_top_sessions"
  | "analytics_summary"
  | "analytics_heatmap"
  | "analytics_hour_of_week"
  | "analytics_projects"
  | "analytics_tools"
  | "activity_report";

export interface EngineReport {
  state: "available" | "unavailable" | string;
  payload: Record<string, unknown>;
  source_version: string | null;
  source_window: Record<string, string | null> | null;
  coverage: Record<string, unknown>;
  error_kind: string | null;
}
