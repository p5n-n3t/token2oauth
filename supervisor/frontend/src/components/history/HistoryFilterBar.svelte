<script lang="ts">
  import Button from "../../lib/kit/components/Button.svelte";
  import type { HistoryFilters } from "../../lib/history-types";
  import { dateInputBoundary, dateInputValue } from "./history-state";
  import HistoryMultiFilter from "./HistoryMultiFilter.svelte";

  interface Props {
    filters: HistoryFilters;
    options: { accounts: string[]; models: string[]; efforts: string[] };
    optionsComplete: boolean;
    refreshing: boolean;
    error: string;
    onChange: (filters: HistoryFilters) => void;
    onRefresh: () => void;
  }
  let { filters, options, optionsComplete, refreshing, error, onChange, onRefresh }: Props = $props();

  function updateList(key: "accounts" | "models" | "efforts", values: string[]) {
    onChange({ ...filters, [key]: values });
  }
  function updateDate(key: "fromUtc" | "toUtc", value: string) {
    const utc = dateInputBoundary(value, filters.timezone, key === "toUtc");
    if (utc) onChange({ ...filters, [key]: utc });
  }
  function updateTimezone(value: string) {
    const fromDate = dateInputValue(filters.fromUtc, filters.timezone);
    const toDate = dateInputValue(filters.toUtc, filters.timezone, true);
    const fromUtc = dateInputBoundary(fromDate, value) ?? filters.fromUtc;
    const toUtc = dateInputBoundary(toDate, value, true) ?? filters.toUtc;
    onChange({ ...filters, timezone: value, fromUtc, toUtc });
  }
</script>

<section class="filter-shell" aria-label="History report filters">
  <div class="filter-row">
    <label class="date-filter"><span>From</span><input type="date" value={dateInputValue(filters.fromUtc, filters.timezone)} onchange={(event) => updateDate("fromUtc", event.currentTarget.value)} /></label>
    <label class="date-filter"><span>To</span><input type="date" value={dateInputValue(filters.toUtc, filters.timezone, true)} onchange={(event) => updateDate("toUtc", event.currentTarget.value)} /></label>
    <label class="timezone-filter"><span>Timezone</span><input aria-label="History timezone" list="history-timezones" value={filters.timezone} onchange={(event) => updateTimezone(event.currentTarget.value)} /><datalist id="history-timezones"><option value="UTC"></option><option value="America/Los_Angeles"></option><option value="America/New_York"></option><option value="Europe/London"></option><option value="Europe/Paris"></option><option value="Asia/Tokyo"></option><option value="Asia/Singapore"></option></datalist></label>
    <HistoryMultiFilter label="Account" values={filters.accounts} options={options.accounts} onchange={(values) => updateList("accounts", values)} />
    <HistoryMultiFilter label="Model" values={filters.models} options={options.models} onchange={(values) => updateList("models", values)} />
    <HistoryMultiFilter label="Effort" values={filters.efforts} options={options.efforts} onchange={(values) => updateList("efforts", values)} />
    <Button tone="info" surface="solid" size="sm" label={refreshing ? "Refreshing" : "Refresh"} disabled={refreshing} onclick={onRefresh} />
  </div>
  {#if error}<p class="filter-error" role="alert">{error}</p>{/if}
  {#if !optionsComplete}<p class="facet-limit-note" role="status">Filter choices may be incomplete while the unfiltered bounded report loads or when its source rows are truncated.</p>{/if}
  <p class="filter-hint">The end date is inclusive; ranges are limited to 366 days. Selected filters are saved in this URL and on this device.</p>
</section>

<style>
  .filter-shell { margin: 0 0 18px; padding: 12px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); }
  .filter-row { display: grid; grid-template-columns: 1fr 1fr minmax(120px, 1.3fr) repeat(3, minmax(90px, .8fr)) auto; align-items: end; gap: 8px; }
  .date-filter, .timezone-filter { min-width: 0; display: grid; gap: 4px; color: var(--text-muted); font-size: 9px; }
  .date-filter input, .timezone-filter input { width: 100%; min-width: 0; height: 35px; padding: 0 8px; border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-primary); background: var(--bg-inset); font-size: 10px; }
  .filter-error { margin: 9px 2px 0; color: var(--accent-red); font-size: 10px; }.facet-limit-note { margin: 8px 2px 0; color: var(--accent-amber); font-size: 9px; }.filter-hint { margin: 8px 2px 0; color: var(--text-muted); font-size: 9px; }
  @media (max-width: 940px) { .filter-row { grid-template-columns: repeat(4, minmax(110px, 1fr)); }.filter-row :global(.kit-button) { width: 100%; } }
  @media (max-width: 560px) { .filter-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }.timezone-filter { grid-column: 1 / -1; }.filter-row :global(.kit-button) { grid-column: 1 / -1; } }
</style>
