<script lang="ts">
  import { onMount } from "svelte";
  import Button from "../../lib/kit/components/Button.svelte";
  import { getHistoryReport, historyExportUrl, historyQuery } from "../../lib/history-api";
  import type { HistoryFilters, HistoryReportResponse, NativeHistoryReport } from "../../lib/history-types";
  import { defaultHistoryFilters, historyShareUrl, loadHistoryFilters, persistHistoryFilters, validateHistoryFilters } from "./history-state";
  import HistoryBreakdowns from "./HistoryBreakdowns.svelte";
  import HistoryCalendarHeatmap from "./HistoryCalendarHeatmap.svelte";
  import HistoryConcurrency from "./HistoryConcurrency.svelte";
  import HistoryCosts from "./HistoryCosts.svelte";
  import HistoryEnginePanel from "./HistoryEnginePanel.svelte";
  import HistoryFilterBar from "./HistoryFilterBar.svelte";
  import HistoryHourHeatmap from "./HistoryHourHeatmap.svelte";
  import HistoryMetricCard from "./HistoryMetricCard.svelte";
  import HistorySessions from "./HistorySessions.svelte";
  import HistorySources from "./HistorySources.svelte";
  import HistoryTrend from "./HistoryTrend.svelte";

  interface Props { oninspect?: (taskId: string) => void }
  type FacetOptions = { accounts: string[]; models: string[]; efforts: string[] };
  interface FacetDomain extends FacetOptions { contextKey: string; projectId: string | null; complete: boolean }
  const EMPTY_FACETS: FacetOptions = { accounts: [], models: [], efforts: [] };
  let { oninspect = () => undefined }: Props = $props();

  let filters = $state<HistoryFilters>(defaultHistoryFilters());
  let response = $state<HistoryReportResponse | null>(null);
  let busy = $state(false);
  let message = $state("");
  let activeController: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let requestNumber = 0;
  let appliedFilterKey = "";
  let appliedContextKey = "";
  let facetDomain = $state<FacetDomain | null>(null);
  let facetRequest: { requestNumber: number; contextKey: string; projectId: string | null; controller: AbortController } | null = null;
  let facetRequestNumber = 0;
  const filterKey = $derived(historyQuery(filters).toString());
  const currentFacetContext = $derived(facetContextKey(filters));
  const validRange = $derived(validateHistoryFilters(filters));
  const stale = $derived(Boolean(response && appliedFilterKey !== filterKey));

  function facetContextKey(value: HistoryFilters): string {
    return JSON.stringify([value.fromUtc, value.toUtc, value.timezone]);
  }

  function hasFacetSelections(value: HistoryFilters): boolean {
    return value.accounts.length > 0 || value.models.length > 0 || value.efforts.length > 0;
  }

  function facetOptionsFromReport(report: NativeHistoryReport): FacetOptions {
    return {
      accounts: report.breakdowns.accounts.map((row) => row.id).filter((value): value is string => Boolean(value)),
      models: [...report.breakdowns.models, ...report.breakdowns.requested_models, ...report.breakdowns.confirmed_models]
        .map((row) => row.id).filter((value): value is string => Boolean(value)),
      efforts: report.breakdowns.efforts.map((row) => row.id),
    };
  }

  function mergeFacetOptions(...sources: FacetOptions[]): FacetOptions {
    const values = (key: keyof FacetOptions) => [...new Set(sources.flatMap((source) => source[key]))].sort();
    return { accounts: values("accounts"), models: values("models"), efforts: values("efforts") };
  }

  function resetFacetDomain(): void {
    facetRequestNumber += 1;
    facetRequest?.controller.abort();
    facetRequest = null;
    facetDomain = null;
  }

  async function loadUnfilteredFacetDomain(requestFilters: HistoryFilters, projectId: string | null): Promise<void> {
    const contextKey = facetContextKey(requestFilters);
    if (facetRequest?.contextKey === contextKey && facetRequest.projectId === projectId) return;
    facetRequest?.controller.abort();
    const currentRequest = ++facetRequestNumber;
    const controller = new AbortController();
    facetRequest = { requestNumber: currentRequest, contextKey, projectId, controller };
    const unfiltered: HistoryFilters = { ...requestFilters, accounts: [], models: [], efforts: [] };
    try {
      // The report endpoint applies the same 10,000-row bound to this same-project/date/timezone query.
      const result = await getHistoryReport(unfiltered, controller.signal);
      if (currentRequest !== facetRequestNumber || contextKey !== facetContextKey(filters) || result.filters.project_id !== projectId) return;
      facetDomain = {
        ...facetOptionsFromReport(result.native),
        contextKey,
        projectId,
        complete: !result.native.coverage.truncated,
      };
    } catch (error) {
      if (currentRequest !== facetRequestNumber || (error instanceof DOMException && error.name === "AbortError")) return;
      // Keep only the visible filtered choices and warn that the unfiltered domain could not be established.
    } finally {
      if (facetRequest?.requestNumber === currentRequest) facetRequest = null;
    }
  }

  function updateFacetDomain(result: HistoryReportResponse, requestFilters: HistoryFilters): void {
    const contextKey = facetContextKey(requestFilters);
    const current = facetDomain;
    const matches = current?.contextKey === contextKey && current.projectId === result.filters.project_id;
    const reportOptions = facetOptionsFromReport(result.native);
    if (!matches) facetDomain = null;

    if (!hasFacetSelections(requestFilters)) {
      if (facetRequest) {
        facetRequestNumber += 1;
        facetRequest.controller.abort();
        facetRequest = null;
      }
      facetDomain = {
        ...reportOptions,
        contextKey,
        projectId: result.filters.project_id,
        complete: !result.native.coverage.truncated,
      };
    } else if (matches && current) {
      facetDomain = { ...current, ...mergeFacetOptions(current, reportOptions) };
    } else {
      void loadUnfilteredFacetDomain(requestFilters, result.filters.project_id);
    }
  }

  function browserStorage(): Pick<Storage, "getItem" | "setItem"> | null {
    try { return typeof window === "undefined" ? null : window.localStorage; }
    catch { return null; }
  }

  const options = $derived.by(() => {
    const useDomain = facetDomain?.contextKey === currentFacetContext && (!response || facetDomain.projectId === response.filters.project_id);
    const useReport = Boolean(response && appliedContextKey === currentFacetContext);
    const source = useDomain ? facetDomain! : useReport ? facetOptionsFromReport(response!.native) : EMPTY_FACETS;
    return mergeFacetOptions(source, filters);
  });
  const facetChoicesComplete = $derived(Boolean(
    facetDomain?.contextKey === currentFacetContext && response && facetDomain.projectId === response.filters.project_id && facetDomain.complete,
  ));

  function cancelReport(): void {
    requestNumber += 1;
    activeController?.abort();
    activeController = null;
  }

  async function refresh(): Promise<void> {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    cancelReport();
    const validation = validateHistoryFilters(filters);
    if (!validation.ok) { message = validation.message; busy = false; return; }
    const current = ++requestNumber;
    const controller = new AbortController();
    activeController = controller;
    const requestedFilters: HistoryFilters = { ...filters, accounts: [...filters.accounts], models: [...filters.models], efforts: [...filters.efforts] };
    const requestedKey = historyQuery(requestedFilters).toString();
    busy = true;
    message = "";
    try {
      const result = await getHistoryReport(requestedFilters, controller.signal);
      if (current !== requestNumber) return;
      response = result;
      appliedFilterKey = requestedKey;
      appliedContextKey = facetContextKey(requestedFilters);
      updateFacetDomain(result, requestedFilters);
    } catch (error) {
      if (current !== requestNumber || (error instanceof DOMException && error.name === "AbortError")) return;
      message = error instanceof Error ? error.message : "History could not be loaded.";
    } finally {
      if (current === requestNumber) { busy = false; activeController = null; }
    }
  }

  function changeFilters(next: HistoryFilters): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = null;
    if (facetContextKey(filters) !== facetContextKey(next)) resetFacetDomain();
    filters = next;
    persistHistoryFilters(next, browserStorage());
    if (typeof window !== "undefined") window.history.replaceState(null, "", historyShareUrl(next, window.location.href));
    cancelReport();
    const validation = validateHistoryFilters(next);
    message = validation.ok ? "" : validation.message;
    busy = false;
    if (!validation.ok) return;
    debounceTimer = setTimeout(() => { void refresh(); }, 280);
  }

  onMount(() => {
    const storage = browserStorage();
    filters = loadHistoryFilters(window.location.search, storage, defaultHistoryFilters());
    persistHistoryFilters(filters, storage);
    window.history.replaceState(null, "", historyShareUrl(filters, window.location.href));
    void refresh();
    return () => { if (debounceTimer) clearTimeout(debounceTimer); cancelReport(); resetFacetDomain(); };
  });
</script>

<section class="history-page page-view" data-testid="rich-history-page" data-has-inspect-handler={typeof oninspect === "function"} aria-labelledby="rich-history-title">
  <div class="page-heading">
    <div><p class="eyebrow">LOCAL EVIDENCE / BOUNDED ANALYTICS</p><h1 id="rich-history-title">History<span class="heading-period">.</span></h1><p class="page-subtitle">Throughput, ownership and imported usage for the current Snooze project, with coverage and source limits in view.</p></div>
    <div class="heading-side"><span class="scope-label">CURRENT PROJECT</span><strong>{response?.filters.project_id ?? "Resolving project scope"}</strong><div class="heading-actions"><a href={historyExportUrl("csv", filters)} class="export-link">Export CSV</a><a href={historyExportUrl("json", filters)} class="export-link">Export JSON</a></div></div>
  </div>

  <HistoryFilterBar filters={filters} {options} optionsComplete={facetChoicesComplete} refreshing={busy} error={message} onChange={changeFilters} onRefresh={() => void refresh()} />
  {#if stale}<p class="stale-banner" role="status">Filters changed. The previous report remains visible while this bounded request updates.</p>{/if}
  {#if response?.native.coverage.truncated}<p class="truncation-banner" role="status"><strong>Bounded report:</strong> one or more source sections reached the 10,000-row limit. Coverage and metric states below retain that limitation.</p>{/if}

  {#if response}
    <div class="metric-grid" aria-label="History summary metrics">
      <HistoryMetricCard label="Recorded events" metric={response.native.summary.events} />
      <HistoryMetricCard label="Validated throughput" metric={response.native.summary.validated_throughput} />
      <HistoryMetricCard label="Queue latency · p50" metric={response.native.summary.queue_latency_p50} />
      <HistoryMetricCard label="Run duration · p50" metric={response.native.summary.run_duration_p50} />
      <HistoryMetricCard label="Retry rate" metric={response.native.summary.retry_rate} />
      <HistoryMetricCard label="Retry attempts" metric={response.native.summary.retry_attempts} />
      <HistoryMetricCard label="Validation failure rate" metric={response.native.summary.validation_failure_rate} />
      <HistoryMetricCard label="Recovery events" metric={response.native.summary.recoveries} />
    </div>

    <div class="section-grid main-charts"><HistoryTrend points={response.native.series} /><HistoryConcurrency points={response.native.concurrency} peak={response.native.summary.concurrency_peak} /></div>
    <div class="section-grid heatmap-grid"><HistoryCalendarHeatmap report={response.native} /><HistoryHourHeatmap cells={response.native.hour_of_week} /></div>

    <section class="token-section" aria-labelledby="token-heading">
      <div class="section-heading"><div><p class="eyebrow">USAGE / IMPORTED FACTS</p><h2 id="token-heading">Tokens and recovery</h2></div><span>Missing token and cost sources remain unavailable.</span></div>
      <div class="metric-grid token-grid">
        <HistoryMetricCard label="Input tokens" metric={response.native.summary.input_tokens} />
        <HistoryMetricCard label="Output tokens" metric={response.native.summary.output_tokens} />
        <HistoryMetricCard label="Reasoning tokens" metric={response.native.summary.reasoning_tokens} />
        <HistoryMetricCard label="Cache read" metric={response.native.summary.cache_read_tokens} />
        <HistoryMetricCard label="Cache write" metric={response.native.summary.cache_write_tokens} />
        <HistoryMetricCard label="Time to recovery · p50" metric={response.native.summary.time_to_recovery_p50} />
      </div>
    </section>

    <div class="section-grid detail-grid"><HistoryBreakdowns report={response.native} /><HistoryCosts series={response.native.series} observed={response.native.summary.observed_cost} estimated={response.native.summary.estimated_cost} /></div>
    <div class="section-grid detail-grid"><HistorySessions sessions={response.native.top_sessions} /><HistorySources sources={response.native.sources} coverage={response.native.coverage} queryMs={response.native.query_ms} /></div>
    <HistoryEnginePanel filters={filters} />
  {:else if busy}
    <div class="loading-state" role="status"><span class="loading-mark">◌</span><strong>Reading current project history</strong><p>Requests are bounded and tied to the selected filters.</p></div>
  {:else if message}
    <div class="error-state"><strong>History is not available yet</strong><p>{message}</p><Button tone="neutral" surface="outline" label="Try again" onclick={() => void refresh()} /></div>
  {:else if !validRange.ok}
    <div class="error-state"><strong>Review the selected range</strong><p>{validRange.message}</p></div>
  {:else}
    <div class="loading-state"><strong>No history report has been loaded.</strong><p>Refresh to request the current project snapshot.</p></div>
  {/if}
</section>

<style>
  .history-page { max-width: 1390px; }.page-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 22px; margin-bottom: 19px; }.eyebrow { margin: 0 0 8px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .13em; }.page-heading h1 { margin: 0; color: var(--text-primary); font-size: clamp(27px, 2.5vw, 32px); line-height: 1.12; font-weight: 640; letter-spacing: -.045em; }.heading-period { color: var(--accent-cyan); }.page-subtitle { max-width: 590px; margin: 8px 0 0; color: var(--text-muted); font-size: 11px; line-height: 1.5; }
  .heading-side { min-width: 175px; display: grid; justify-items: end; gap: 5px; padding-top: 6px; }.scope-label { color: var(--text-muted); font-size: 8px; font-weight: 700; letter-spacing: .12em; }.heading-side > strong { max-width: 220px; overflow: hidden; color: var(--text-secondary); font: 10px "JetBrains Mono", monospace; text-overflow: ellipsis; }.heading-actions { display: flex; gap: 6px; margin-top: 4px; }.export-link { display: inline-flex; align-items: center; height: 27px; padding: 0 8px; border: 1px solid var(--border-default); border-radius: 5px; color: var(--text-secondary); background: var(--bg-surface); font-size: 9px; text-decoration: none; }.export-link:hover { border-color: var(--accent-cyan); color: var(--accent-cyan); }
  .stale-banner, .truncation-banner { margin: 0 0 13px; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--accent-amber) 35%, var(--border-default)); border-radius: 6px; color: var(--text-secondary); background: color-mix(in srgb, var(--accent-amber) 7%, var(--bg-surface)); font-size: 10px; }.truncation-banner strong { color: var(--accent-amber); }
  .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }.section-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); gap: 10px; margin-bottom: 10px; }.heatmap-grid { grid-template-columns: minmax(0, .95fr) minmax(0, 1.05fr); }.detail-grid { grid-template-columns: minmax(0, 1.12fr) minmax(0, .88fr); }
  .token-section { margin: 6px 0 13px; }.section-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 9px; }.section-heading .eyebrow { margin-bottom: 4px; }.section-heading h2 { margin: 0; font-size: 14px; font-weight: 610; }.section-heading > span { color: var(--text-muted); font-size: 9px; }.token-grid { grid-template-columns: repeat(6, minmax(0, 1fr)); margin: 0; }
  .loading-state, .error-state { min-height: 220px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; border: 1px dashed var(--border-default); border-radius: 8px; color: var(--text-primary); background: var(--bg-surface); text-align: center; }.loading-mark { color: var(--accent-cyan); font-size: 26px; }.loading-state strong, .error-state strong { font-size: 13px; }.loading-state p, .error-state p { max-width: 400px; margin: 0; color: var(--text-muted); font-size: 10px; line-height: 1.5; }.error-state p { color: var(--accent-red); }
  @media (max-width: 1120px) { .metric-grid, .token-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }.section-grid, .heatmap-grid, .detail-grid { grid-template-columns: minmax(0, 1fr); } }
  @media (max-width: 560px) { .page-heading { flex-direction: column; gap: 12px; }.heading-side { width: 100%; justify-items: start; }.metric-grid, .token-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }.section-heading { align-items: flex-start; flex-direction: column; } }
</style>
