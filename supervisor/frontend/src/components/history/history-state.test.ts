import { describe, expect, it } from "vitest";
import { dateInputBoundary, dateInputValue, defaultHistoryFilters, historyShareUrl, loadHistoryFilters, localDateToUtc, persistHistoryFilters, validateHistoryFilters } from "./history-state";

function storage(value: string | null) {
  return { getItem: () => value, setItem: (_key: string, _value: string) => undefined };
}

describe("History filter state", () => {
  it("uses timezone wall dates for UTC boundaries across daylight saving", () => {
    expect(localDateToUtc("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00.000Z");
    expect(localDateToUtc("2026-03-09", "America/New_York")).toBe("2026-03-09T04:00:00.000Z");
    expect(dateInputBoundary("2026-03-08", "America/New_York", true)).toBe("2026-03-09T04:00:00.000Z");
    expect(dateInputValue("2026-03-09T04:00:00.000Z", "America/New_York", true)).toBe("2026-03-08");
  });

  it("hydrates repeated filter values from a shared URL ahead of local preferences", () => {
    const fallback = defaultHistoryFilters(new Date("2026-10-07T12:00:00Z"), "UTC");
    const saved = JSON.stringify({ ...fallback, accounts: ["stored-account"] });
    const loaded = loadHistoryFilters("?from_utc=2026-10-01T00%3A00%3A00.000Z&to_utc=2026-10-08T00%3A00%3A00.000Z&timezone=Asia%2FTokyo&accounts=night%20shift&accounts=secondary&models=codex", storage(saved), fallback);
    expect(loaded.timezone).toBe("Asia/Tokyo");
    expect(loaded.accounts).toEqual(["night shift", "secondary"]);
    expect(loaded.models).toEqual(["codex"]);
  });

  it("bounds persisted values and falls back when a shared range is invalid", () => {
    const fallback = defaultHistoryFilters(new Date("2026-10-07T12:00:00Z"), "UTC");
    const unsafe = JSON.stringify({ ...fallback, accounts: ["good", "<img onerror=x>", "bad\u0000value", "x".repeat(200)] });
    expect(loadHistoryFilters("", storage(unsafe), fallback).accounts).toEqual(["good", "<img onerror=x>"]);
    const invalidUrl = "?from_utc=2026-01-01T00%3A00%3A00Z&to_utc=2027-02-01T00%3A00%3A00Z&timezone=UTC";
    expect(loadHistoryFilters(invalidUrl, storage(null), fallback)).toEqual(fallback);
    expect(validateHistoryFilters({ ...fallback, timezone: "Mars/Olympus" }).ok).toBe(false);
  });

  it("accepts 20 repeated values and caps restored facet values at the API limit of 20", () => {
    const fallback = defaultHistoryFilters(new Date("2026-10-07T12:00:00Z"), "UTC");
    const values = Array.from({ length: 21 }, (_, index) => `choice-${index}`);
    const makeUrl = (count: number) => {
      const params = new URLSearchParams();
      params.set("from_utc", fallback.fromUtc);
      params.set("to_utc", fallback.toUtc);
      params.set("timezone", fallback.timezone);
      for (const key of ["accounts", "models", "efforts"] as const) {
        for (const value of values.slice(0, count)) params.append(key, `${key}-${value}`);
      }
      return `?${params.toString()}`;
    };

    const twenty = loadHistoryFilters(makeUrl(20), storage(null), fallback);
    expect(twenty.accounts).toHaveLength(20);
    expect(twenty.models).toHaveLength(20);
    expect(twenty.efforts).toHaveLength(20);

    const twentyOne = loadHistoryFilters(makeUrl(21), storage(null), fallback);
    expect(twentyOne.accounts).toEqual(twenty.accounts);
    expect(twentyOne.models).toEqual(twenty.models);
    expect(twentyOne.efforts).toEqual(twenty.efforts);

    let persisted = "";
    persistHistoryFilters({ ...fallback, accounts: values }, { setItem: (_key, value) => { persisted = value; } });
    expect(loadHistoryFilters("", storage(persisted), fallback).accounts).toEqual(values.slice(0, 20));
    expect(() => historyShareUrl({ ...fallback, accounts: values }, "https://snooze.test/history")).toThrow(/20 values/);
  });

  it("shares the selected filters while preserving unrelated route state", () => {
    const filters = { ...defaultHistoryFilters(new Date("2026-10-07T12:00:00Z"), "UTC"), accounts: ["acct one", "acct/two"], models: ["model"], efforts: ["high"] };
    const shared = new URL(historyShareUrl(filters, "https://snooze.test/history?tab=history#report"), "https://snooze.test");
    expect(shared.pathname).toBe("/history");
    expect(shared.searchParams.get("tab")).toBe("history");
    expect(shared.searchParams.getAll("accounts")).toEqual(["acct one", "acct/two"]);
    expect(shared.searchParams.getAll("models")).toEqual(["model"]);
    expect(shared.hash).toBe("#report");
  });
});
