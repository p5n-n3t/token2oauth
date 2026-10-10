import { describe, expect, it, vi } from "vitest";
import { getEngineReport, getHistoryReport, historyExportUrl, historyQuery } from "../../lib/history-api";
import { defaultHistoryFilters } from "./history-state";

describe("History API", () => {
  const filters = { ...defaultHistoryFilters(new Date("2026-10-07T12:00:00Z"), "UTC"), accounts: ["acct a", "acct/b"], models: ["model-x"], efforts: ["high", "medium"] };

  it("encodes every selected filter as a repeated same-origin query value", () => {
    const query = historyQuery(filters);
    expect(query.getAll("accounts")).toEqual(["acct a", "acct/b"]);
    expect(query.getAll("models")).toEqual(["model-x"]);
    expect(query.getAll("efforts")).toEqual(["high", "medium"]);
    const csv = new URL(historyExportUrl("csv", filters), "https://snooze.test");
    expect(csv.origin).toBe("https://snooze.test");
    expect(csv.pathname).toBe("/api/v2/history/export");
    expect(csv.searchParams.get("format")).toBe("csv");
    expect(csv.searchParams.getAll("accounts")).toEqual(["acct a", "acct/b"]);
  });

  it("serializes up to 20 values per facet and refuses requests that exceed the API contract", () => {
    const values = Array.from({ length: 20 }, (_, index) => `choice-${index}`);
    const atLimit = { ...filters, accounts: values, models: values, efforts: values };
    const query = historyQuery(atLimit);
    expect(query.getAll("accounts")).toHaveLength(20);
    expect(query.getAll("models")).toHaveLength(20);
    expect(query.getAll("efforts")).toHaveLength(20);

    for (const key of ["accounts", "models", "efforts"] as const) {
      const overLimit = Array.from({ length: 21 }, (_, index) => `choice-${index}`);
      expect(() => historyQuery({ ...filters, [key]: overLimit })).toThrow(/20 values/);
      expect(() => historyExportUrl("csv", { ...filters, [key]: overLimit })).toThrow(/20 values/);
    }
  });

  it("requests the native report and optional engine with credentials and cancellation", async () => {
    const controller = new AbortController();
    const reportFetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ native: {}, filters: {}, bounded_rows: 10000 }), { status: 200 }));
    await getHistoryReport(filters, controller.signal, reportFetcher);
    const reportCall = reportFetcher.mock.calls[0]!;
    expect(String(reportCall[0])).toContain("/api/v2/history/report?");
    expect(new URLSearchParams(String(reportCall[0]).split("?")[1]).getAll("accounts")).toEqual(filters.accounts);
    expect(reportCall[1]).toMatchObject({ credentials: "same-origin", signal: controller.signal, method: "GET" });

    const engineFetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ state: "unavailable", payload: {}, source_version: null, source_window: null, coverage: { state: "unavailable" }, error_kind: "not_configured" }), { status: 200 }));
    const engine = await getEngineReport("analytics_summary", filters, undefined, engineFetcher);
    expect(engine.state).toBe("unavailable");
    expect(engine.error_kind).toBe("not_configured");
    expect(String(engineFetcher.mock.calls[0]?.[0])).toContain("kind=analytics_summary");
  });

  it("surfaces server validation errors without hiding their message", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ error: "Choose a range no longer than 366 days." }), { status: 400 }));
    await expect(getHistoryReport(filters, undefined, fetcher)).rejects.toThrow("Choose a range no longer than 366 days.");
  });
});
