import type { DashboardState, HistoryPage, InboxPage, QueuePage, TaskDetail } from "./types";

export interface ControlRequest {
  action: string;
  target_id: string;
  values: Record<string, unknown>;
  expected_revision: number;
}

export interface ControlReceipt {
  action_id: string;
  state: "confirmed" | "pending" | "rejected" | string;
  reason: string | null;
  revision: number;
  status_code: number;
}

type Fetcher = typeof fetch;

async function jsonRequest<T>(path: string, init?: RequestInit, fetcher: Fetcher = fetch): Promise<T> {
  const response = await fetcher(path, { credentials: "same-origin", ...init });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Snooze returned an unreadable response (${response.status}).`);
  }
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "error" in payload
      ? String((payload as { error: unknown }).error)
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return payload as T;
}

export function getDashboardState(signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<DashboardState> {
  return jsonRequest<DashboardState>("/api/v2/state", { signal }, fetcher);
}

export function getTaskDetail(taskId: string, fetcher?: Fetcher): Promise<TaskDetail> {
  return jsonRequest<TaskDetail>(`/api/v2/tasks/${encodeURIComponent(taskId)}`, undefined, fetcher);
}

export function postLegacy(path: "/api/check" | "/api/ack" | "/api/settings", body: Record<string, unknown>, fetcher?: Fetcher) {
  return jsonRequest<{ ok: boolean }>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, fetcher);
}

/** Return the coordinator receipt for all HTTP statuses, including typed 4xx/5xx rejections. */
export async function postControl(request: ControlRequest, fetcher: Fetcher = fetch): Promise<ControlReceipt> {
  const response = await fetcher("/api/v2/control", {
    credentials: "same-origin",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  let payload: unknown;
  try { payload = await response.json(); }
  catch { throw new Error(`Snooze returned an unreadable action receipt (${response.status}).`); }
  if (!payload || typeof payload !== "object" || !("state" in payload)) {
    throw new Error(`Snooze returned an invalid action receipt (${response.status}).`);
  }
  const receipt = payload as Partial<ControlReceipt>;
  return {
    action_id: typeof receipt.action_id === "string" ? receipt.action_id : "",
    state: String(receipt.state),
    reason: typeof receipt.reason === "string" ? receipt.reason : null,
    revision: Number.isInteger(receipt.revision) ? Number(receipt.revision) : request.expected_revision,
    status_code: Number.isInteger(receipt.status_code) ? Number(receipt.status_code) : response.status,
  };
}

/** Fetch only the requested server page; never download or retain the full history snapshot. */
export function getHistory(options: { offset: number; limit: number; query: string }, fetcher: Fetcher = fetch): Promise<HistoryPage> {
  const params = new URLSearchParams({ offset: String(options.offset), limit: String(options.limit) });
  if (options.query.trim()) params.set("q", options.query.trim());
  return jsonRequest<HistoryPage>(`/api/v2/history/events?${params.toString()}`, undefined, fetcher);
}

export function getQueue(offset: number, limit = 50, fetcher?: Fetcher): Promise<QueuePage> {
  return jsonRequest<QueuePage>(`/api/v2/queue?offset=${offset}&limit=${limit}`, undefined, fetcher);
}

export function getProviders(fetcher?: Fetcher): Promise<{ accounts: DashboardState["accounts"] }> {
  return jsonRequest<{ accounts: DashboardState["accounts"] }>("/api/v2/providers", undefined, fetcher);
}

export function getInbox(fetcher?: Fetcher): Promise<InboxPage> {
  return jsonRequest<InboxPage>("/api/v2/inbox", undefined, fetcher);
}
