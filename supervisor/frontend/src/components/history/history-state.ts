import { HISTORY_FILTER_VALUE_LIMIT, assertHistoryFilterCardinality, type HistoryFilters } from "../../lib/history-types";

const STORAGE_KEY = "snooze.history.filters.v1";
const URL_KEYS = ["from_utc", "to_utc", "timezone", "accounts", "models", "efforts"] as const;
const MAX_FILTER_VALUE_LENGTH = 160;
const MAX_RANGE_DAYS = 366;

function validTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

function cleanValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0 && item.length <= MAX_FILTER_VALUE_LENGTH && !/[\u0000-\u001f\u007f]/.test(item)))
  ].slice(0, HISTORY_FILTER_VALUE_LIMIT);
}

export function timezoneDate(instant: string, timezone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: validTimezone(timezone) ? timezone : "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function shiftCalendarDate(dateValue: string, amount: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !Number.isInteger(amount)) return "";
  const date = new Date(dateValue + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function dateInputValue(instant: string, timezone: string, inclusiveEnd = false): string {
  const localDate = timezoneDate(instant, timezone);
  return inclusiveEnd ? shiftCalendarDate(localDate, -1) : localDate;
}

export function dateInputBoundary(dateValue: string, timezone: string, inclusiveEnd = false): string | null {
  const boundaryDate = inclusiveEnd ? shiftCalendarDate(dateValue, 1) : dateValue;
  return localDateToUtc(boundaryDate, timezone);
}

/** Convert a calendar date in the selected IANA timezone to its UTC midnight. */
export function localDateToUtc(dateValue: string, timezone: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateValue) || !validTimezone(timezone)) return null;
  const [year, month, day] = dateValue.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!);
  const check = new Date(target);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month! - 1 || check.getUTCDate() !== day) return null;

  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (type: string) => Number(parts.find((item) => item.type === type)?.value ?? 0);
    const represented = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
    const adjustment = target - represented;
    if (adjustment === 0) break;
    guess += adjustment;
  }
  return new Date(guess).toISOString();
}

export function defaultHistoryFilters(now = new Date(), timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"): HistoryFilters {
  const zone = validTimezone(timezone) ? timezone : "UTC";
  const today = timezoneDate(now.toISOString(), zone);
  const end = new Date(`${today}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  return {
    fromUtc: localDateToUtc(start.toISOString().slice(0, 10), zone) ?? start.toISOString(),
    toUtc: localDateToUtc(end.toISOString().slice(0, 10), zone) ?? end.toISOString(),
    timezone: zone,
    accounts: [], models: [], efforts: [],
  };
}

function sanitizeFilters(value: unknown, fallback: HistoryFilters): HistoryFilters {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<HistoryFilters>;
  return {
    fromUtc: validIso(candidate.fromUtc) ? new Date(candidate.fromUtc).toISOString() : fallback.fromUtc,
    toUtc: validIso(candidate.toUtc) ? new Date(candidate.toUtc).toISOString() : fallback.toUtc,
    timezone: validTimezone(candidate.timezone) ? candidate.timezone : fallback.timezone,
    accounts: cleanValues(candidate.accounts),
    models: cleanValues(candidate.models),
    efforts: cleanValues(candidate.efforts),
  };
}

export function loadHistoryFilters(search: string, storage: Pick<Storage, "getItem"> | null, fallback = defaultHistoryFilters()): HistoryFilters {
  let stored = fallback;
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) {
      const candidate = sanitizeFilters(JSON.parse(raw), fallback);
      stored = validateHistoryFilters(candidate).ok ? candidate : fallback;
    }
  } catch {
    stored = fallback;
  }
  const params = new URLSearchParams(search);
  if (!URL_KEYS.some((key) => params.has(key))) return stored;

  const merged: HistoryFilters = {
    fromUtc: params.has("from_utc") && validIso(params.get("from_utc"))
      ? new Date(params.get("from_utc")!).toISOString() : stored.fromUtc,
    toUtc: params.has("to_utc") && validIso(params.get("to_utc"))
      ? new Date(params.get("to_utc")!).toISOString() : stored.toUtc,
    timezone: params.has("timezone") && validTimezone(params.get("timezone"))
      ? params.get("timezone")! : stored.timezone,
    accounts: params.has("accounts") ? cleanValues(params.getAll("accounts")) : stored.accounts,
    models: params.has("models") ? cleanValues(params.getAll("models")) : stored.models,
    efforts: params.has("efforts") ? cleanValues(params.getAll("efforts")) : stored.efforts,
  };
  return validateHistoryFilters(merged).ok ? merged : stored;
}

export function validateHistoryFilters(filters: HistoryFilters): { ok: true } | { ok: false; message: string } {
  const from = Date.parse(filters.fromUtc);
  const to = Date.parse(filters.toUtc);
  if (!validTimezone(filters.timezone)) return { ok: false, message: "Choose a valid IANA timezone." };
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    return { ok: false, message: "The start date must be earlier than the end date." };
  }
  if (to - from > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return { ok: false, message: "Choose a date range of 366 days or less." };
  }
  return { ok: true };
}

function writeParams(params: URLSearchParams, filters: HistoryFilters): void {
  assertHistoryFilterCardinality(filters);
  for (const key of URL_KEYS) params.delete(key);
  params.set("from_utc", filters.fromUtc);
  params.set("to_utc", filters.toUtc);
  params.set("timezone", filters.timezone);
  for (const value of filters.accounts) params.append("accounts", value);
  for (const value of filters.models) params.append("models", value);
  for (const value of filters.efforts) params.append("efforts", value);
}

export function persistHistoryFilters(filters: HistoryFilters, storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(sanitizeFilters(filters, defaultHistoryFilters())));
  } catch {
    // Private browsing and storage quota restrictions should not block reports.
  }
}

export function historyShareUrl(filters: HistoryFilters, currentUrl: string): string {
  const url = new URL(currentUrl);
  writeParams(url.searchParams, filters);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function formatMetricValue(metric: { value: number | null; unit: string } | undefined): string {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) return "Unavailable";
  const { value, unit } = metric;
  if (unit === "ratio") return `${(value * 100).toFixed(value * 100 % 1 ? 1 : 0)}%`;
  if (unit === "seconds") return value < 60 ? `${value.toFixed(value % 1 ? 1 : 0)}s` : `${(value / 60).toFixed(1)}m`;
  if (unit === "tokens" || unit === "events" || unit === "attempts" || unit === "validated tasks" || unit === "recovery events") {
    return Math.round(value).toLocaleString();
  }
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;
}

export function coverageLabel(coverage: { observed: number | null; eligible: number | null }): string {
  const observed = coverage.observed === null ? "Sample count unavailable" : `${coverage.observed.toLocaleString()} observed`;
  return coverage.eligible === null ? `${observed} · eligible total unavailable` : `${observed} of ${coverage.eligible.toLocaleString()} eligible`;
}
