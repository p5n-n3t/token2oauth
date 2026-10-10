import type {
  EngineReport,
  EngineReportKind,
  HistoryFilters,
  HistoryReportResponse,
} from "./history-types";
import { assertHistoryFilterCardinality } from "./history-types";

type Fetcher = typeof fetch;

const HISTORY_BASE = "/api/v2/history";

export function historyQuery(filters: HistoryFilters): URLSearchParams {
  assertHistoryFilterCardinality(filters);
  const query = new URLSearchParams();
  query.set("from_utc", filters.fromUtc);
  query.set("to_utc", filters.toUtc);
  query.set("timezone", filters.timezone);
  for (const value of filters.accounts) query.append("accounts", value);
  for (const value of filters.models) query.append("models", value);
  for (const value of filters.efforts) query.append("efforts", value);
  return query;
}

export function historyExportUrl(format: "json" | "csv", filters: HistoryFilters): string {
  const query = historyQuery(filters);
  query.set("format", format);
  return `${HISTORY_BASE}/export?${query.toString()}`;
}

async function requestJson<T>(path: string, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(path, { method: "GET", credentials: "same-origin", signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error("History could not reach Snooze. Check the connection and try again.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Snooze returned an unreadable history response (${response.status}).`);
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `History request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

export function getHistoryReport(
  filters: HistoryFilters,
  signal?: AbortSignal,
  fetcher?: Fetcher,
): Promise<HistoryReportResponse> {
  return requestJson<HistoryReportResponse>(`${HISTORY_BASE}/report?${historyQuery(filters).toString()}`, signal, fetcher);
}

export function getEngineReport(
  kind: EngineReportKind,
  filters: HistoryFilters,
  signal?: AbortSignal,
  fetcher?: Fetcher,
): Promise<EngineReport> {
  const query = historyQuery(filters);
  query.set("kind", kind);
  return requestJson<EngineReport>(`${HISTORY_BASE}/engine?${query.toString()}`, signal, fetcher);
}
