import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEngineReport, getHistoryReport } from "../../lib/history-api";
import HistoryPage from "./HistoryPage.svelte";
import { makeHistoryResponse } from "./history-fixtures";
import type { HistoryFilters, HistoryReportResponse } from "../../lib/history-types";

vi.mock("../../lib/history-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/history-api")>();
  return { ...actual, getHistoryReport: vi.fn(), getEngineReport: vi.fn() };
});

const mockedHistory = vi.mocked(getHistoryReport);
const mockedEngine = vi.mocked(getEngineReport);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function withFacets(facets: { accounts: string[]; models: string[]; efforts: string[] }, projectId = "current-snooze"): HistoryReportResponse {
  const base = makeHistoryResponse();
  const account = base.native.breakdowns.accounts[0]!;
  const model = base.native.breakdowns.models[0]!;
  return {
    ...base,
    filters: { ...base.filters, project_id: projectId },
    native: {
      ...base.native,
      breakdowns: {
        ...base.native.breakdowns,
        accounts: facets.accounts.map((id) => ({ ...account, id })),
        models: facets.models.map((id) => ({ ...model, id })),
        requested_models: [],
        confirmed_models: [],
        efforts: facets.efforts.map((id) => ({ id, event_count: 1 })),
      },
    },
  };
}

async function openFilter(label: string) {
  const summary = Array.from(document.querySelectorAll("summary")).find((item) => item.textContent?.includes(label));
  if (!summary) throw new Error(`Could not find the ${label} filter summary`);
  await fireEvent.click(summary);
}

describe("HistoryPage", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/history?from_utc=2026-10-01T00%3A00%3A00.000Z&to_utc=2026-10-08T00%3A00%3A00.000Z&timezone=UTC");
    window.localStorage.clear();
    mockedHistory.mockReset();
    mockedEngine.mockReset();
    mockedHistory.mockResolvedValue(makeHistoryResponse());
    mockedEngine.mockResolvedValue({ state: "unavailable", payload: {}, source_version: null, source_window: null, coverage: { state: "unavailable" }, error_kind: "not_configured" });
  });
  afterEach(() => cleanup());

  it("renders real zero separately from unavailable metrics and exposes current project exports", async () => {
    render(HistoryPage);
    await screen.findByText("current-snooze");
    const zeroMetric = screen.getByText("Recorded events").closest("article");
    expect(zeroMetric && within(zeroMetric).getByText("4")).toBeTruthy();
    const retries = screen.getByText("Retry rate").closest("article");
    expect(retries && within(retries).getByText("0%")).toBeTruthy();
    const input = screen.getByText("Input tokens").closest("article");
    expect(input && within(input).getByText("Unavailable")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toContain("/api/v2/history/export?");
    expect(screen.getByRole("link", { name: "Export JSON" }).getAttribute("href")).toContain("format=json");
  });

  it("keeps observed and estimated currencies labeled separately and shows provenance", async () => {
    render(HistoryPage);
    await screen.findByText("current-snooze");
    expect(screen.getByRole("heading", { name: "Provider reported" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Estimated" })).toBeTruthy();
    expect(screen.getAllByText("1.25 USD")).toHaveLength(2);
    expect(screen.getByText("1.5 EUR")).toBeTruthy();
    expect(screen.getByText("2.1 USD")).toBeTruthy();
    expect(screen.getByText("provider_reported")).toBeTruthy();
    expect(screen.getByText("2.4.1+abc123 (API 1)")).toBeTruthy();
  });

  it("loads the optional external engine report only when requested and keeps it unavailable", async () => {
    render(HistoryPage);
    await screen.findByText("current-snooze");
    expect(mockedEngine).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole("button", { name: "Load external report" }));
    await screen.findByText("No provider analytics service is configured.");
    expect(mockedEngine).toHaveBeenCalledTimes(1);
    expect(mockedEngine.mock.calls[0]?.[0]).toBe("usage_summary");
    expect(screen.getByText(/Snooze-native totals above are unchanged/)).toBeTruthy();
  });

  it("coalesces rapid filter edits into one bounded report request", async () => {
    render(HistoryPage);
    await screen.findByText("current-snooze");
    await fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-09" } });
    await fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-10" } });
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2), { timeout: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(mockedHistory).toHaveBeenCalledTimes(2);
    expect(mockedHistory.mock.calls[1]?.[0].toUtc).toBe("2026-10-11T00:00:00.000Z");
  });

  it.each([
    { key: "accounts", label: "Account", values: ["account-a", "account-b"] },
    { key: "models", label: "Model", values: ["model-a", "model-b"] },
    { key: "efforts", label: "Effort", values: ["effort-a", "effort-b"] },
  ] as const)("keeps the complete $label choice domain after a narrowed response", async ({ key, label, values }) => {
    const complete = { accounts: ["account-a", "account-b"], models: ["model-a", "model-b"], efforts: ["effort-a", "effort-b"] };
    mockedHistory.mockImplementation(async (requestFilters: HistoryFilters) => {
      const responseFacets = { ...complete, [key]: requestFilters[key].length ? requestFilters[key] : complete[key] };
      return withFacets(responseFacets);
    });

    render(HistoryPage);
    await screen.findByText("current-snooze");
    await openFilter(label);
    await fireEvent.click(screen.getByLabelText(values[0]!));
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2), { timeout: 2000 });
    await screen.findByLabelText(values[1]!);

    await fireEvent.click(screen.getByLabelText(values[1]!));
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(3), { timeout: 2000 });
    expect(mockedHistory.mock.calls[2]?.[0][key]).toEqual(values);
  });

  it("rebuilds the unfiltered facet domain when the date context changes", async () => {
    mockedHistory.mockImplementation(async (requestFilters: HistoryFilters) => {
      const changedContext = requestFilters.toUtc > "2026-10-08T00:00:00.000Z";
      const domainAccounts = changedContext ? ["account-c", "account-d"] : ["account-a", "account-b"];
      return withFacets({
        accounts: requestFilters.accounts.length ? requestFilters.accounts : domainAccounts,
        models: ["model-a"],
        efforts: ["effort-a"],
      });
    });

    render(HistoryPage);
    await screen.findByText("current-snooze");
    await openFilter("Account");
    await fireEvent.click(screen.getByLabelText("account-a"));
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2), { timeout: 2000 });

    await fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-09" } });
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(4), { timeout: 2500 });
    expect(mockedHistory.mock.calls[2]?.[0].toUtc).toBe("2026-10-10T00:00:00.000Z");
    expect(mockedHistory.mock.calls[3]?.[0]).toMatchObject({ accounts: [], models: [], efforts: [] });
    await screen.findByLabelText("account-c");
    expect(screen.queryByLabelText("account-b")).toBeNull();
    expect((screen.getByLabelText("account-a") as HTMLInputElement).checked).toBe(true);
  });

  it("discards a prior project's choices when the report changes project scope", async () => {
    let requestCount = 0;
    mockedHistory.mockImplementation(async (requestFilters: HistoryFilters) => {
      requestCount += 1;
      const projectId = requestCount === 1 ? "project-one" : "project-two";
      const accounts = requestFilters.accounts.length
        ? requestFilters.accounts
        : requestCount === 1 ? ["account-a", "account-b"] : ["account-c", "account-d"];
      return withFacets({ accounts, models: ["model-a"], efforts: ["effort-a"] }, projectId);
    });

    render(HistoryPage);
    await screen.findByText("project-one");
    await openFilter("Account");
    await fireEvent.click(screen.getByLabelText("account-a"));
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(3), { timeout: 2500 });
    expect(mockedHistory.mock.calls[2]?.[0]).toMatchObject({ accounts: [], models: [], efforts: [] });
    await screen.findByLabelText("account-c");
    expect(screen.queryByLabelText("account-b")).toBeNull();
    expect((screen.getByLabelText("account-a") as HTMLInputElement).checked).toBe(true);
  });

  it("discloses when a truncated unfiltered report can provide only partial facet choices", async () => {
    const truncated = withFacets({ accounts: ["account-a"], models: ["model-a"], efforts: ["effort-a"] });
    truncated.native.coverage.truncated = true;
    mockedHistory.mockResolvedValue(truncated);

    render(HistoryPage);
    await screen.findByText("current-snooze");
    expect(screen.getByText(/Filter choices may be incomplete/)).toBeTruthy();
  });

  it("does not allow selecting a 21st facet value when 20 came from a shared URL", async () => {
    const params = new URLSearchParams(window.location.search);
    for (let index = 0; index < 20; index += 1) params.append("accounts", `account-${index}`);
    window.history.replaceState(null, "", `/history?${params.toString()}`);
    mockedHistory.mockResolvedValue(withFacets({
      accounts: Array.from({ length: 21 }, (_, index) => `account-${index}`),
      models: [], efforts: [],
    }));

    render(HistoryPage);
    await screen.findByText("current-snooze");
    expect(mockedHistory.mock.calls[0]?.[0].accounts).toHaveLength(20);
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2), { timeout: 2000 });
    expect(mockedHistory.mock.calls[1]?.[0]).toMatchObject({ accounts: [], models: [], efforts: [], fromUtc: mockedHistory.mock.calls[0]?.[0].fromUtc, toUtc: mockedHistory.mock.calls[0]?.[0].toUtc, timezone: "UTC" });
    await openFilter("Account");
    const twentyFirst = screen.getByLabelText("account-20") as HTMLInputElement;
    expect(twentyFirst.disabled).toBe(true);
    await fireEvent.click(twentyFirst);
    expect(mockedHistory).toHaveBeenCalledTimes(2);
  });

  it("keeps a stale response visible while filters refresh and ignores a late cancelled result", async () => {
    const cancelledResponse = deferred<ReturnType<typeof makeHistoryResponse>>();
    const currentResponse = deferred<ReturnType<typeof makeHistoryResponse>>();
    mockedHistory.mockReset().mockResolvedValueOnce(makeHistoryResponse({ events: 4 })).mockReturnValueOnce(cancelledResponse.promise).mockReturnValueOnce(currentResponse.promise);
    const inspected = vi.fn();
    render(HistoryPage, { props: { oninspect: inspected } });
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(1));
    await screen.findByText("current-snooze");

    await fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-10" } });
    expect(screen.getByText(/Filters changed/)).toBeTruthy();
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(2), { timeout: 1500 });
    await fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-11" } });
    await waitFor(() => expect(mockedHistory).toHaveBeenCalledTimes(3), { timeout: 1500 });
    currentResponse.resolve(makeHistoryResponse({ events: 21 }));
    const eventCard = screen.getByText("Recorded events").closest("article");
    await waitFor(() => expect(eventCard && within(eventCard).getByText("21")).toBeTruthy());

    cancelledResponse.resolve(makeHistoryResponse({ events: 99 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(eventCard && within(eventCard).queryByText("99")).toBeNull();
    expect(inspected).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Inspect task" })).toBeNull();
  });
});
