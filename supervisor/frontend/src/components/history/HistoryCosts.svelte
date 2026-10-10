<script lang="ts">
  import type { CurrencyAmount, HistoryMetric, HistorySeriesPoint } from "../../lib/history-types";
  import { formatMetricValue } from "./history-state";
  let { series, observed, estimated }: { series: HistorySeriesPoint[]; observed?: HistoryMetric; estimated?: HistoryMetric } = $props();

  function totals(key: "observed_costs" | "estimated_costs"): CurrencyAmount[] {
    const values = new Map<string, number>();
    for (const point of series) for (const cost of point[key] ?? []) values.set(cost.currency, (values.get(cost.currency) ?? 0) + cost.value);
    return [...values.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([currency, value]) => ({ currency, value }));
  }
  const observedTotals = $derived(totals("observed_costs"));
  const estimatedTotals = $derived(totals("estimated_costs"));
</script>

<section class="panel cost-panel" aria-labelledby="cost-heading">
  <div class="panel-heading"><div><p class="eyebrow">USAGE / SOURCE-CARRIED COSTS</p><h2 id="cost-heading">Cost stays attributable</h2></div></div>
  <div class="cost-columns">
    <article class="cost-kind"><div><span class="cost-dot reported"></span><h3>Provider reported</h3></div><strong>{formatMetricValue(observed)}</strong><p>{observed?.source ?? "No reported-cost source"}</p>
      {#if observedTotals.length}<ul>{#each observedTotals as cost (cost.currency)}<li><b>{cost.value.toLocaleString(undefined, { maximumFractionDigits: 4 })} {cost.currency}</b><span>observed</span></li>{/each}</ul>{:else}<small>No currency-labeled reported amount is available.</small>{/if}
    </article>
    <article class="cost-kind"><div><span class="cost-dot estimated"></span><h3>Estimated</h3></div><strong>{formatMetricValue(estimated)}</strong><p>{estimated?.source ?? "No estimate source"}</p>
      {#if estimatedTotals.length}<ul>{#each estimatedTotals as cost (cost.currency)}<li><b>{cost.value.toLocaleString(undefined, { maximumFractionDigits: 4 })} {cost.currency}</b><span>estimated</span></li>{/each}</ul>{:else}<small>No currency-labeled estimate is available.</small>{/if}
    </article>
  </div>
  {#if observed?.value === null && observedTotals.length > 0}<p class="cost-note">The total remains unavailable because currencies are mixed or some source amounts have no currency label. The listed currencies are kept separate.</p>{/if}
  <p class="cost-note">Reported and estimated amounts come from separate source fields and are never added together.</p>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }.panel-heading { margin-bottom: 14px; }.eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 14px; font-weight: 610; }
  .cost-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }.cost-kind { min-width: 0; padding: 12px; border: 1px solid var(--border-muted); border-radius: 7px; background: var(--bg-inset); }.cost-kind > div { display: flex; align-items: center; gap: 7px; }.cost-dot { width: 7px; height: 7px; border-radius: 50%; }.reported { background: var(--accent-cyan); }.estimated { background: var(--accent-lavender); }
  h3 { margin: 0; font-size: 10px; font-weight: 620; }.cost-kind > strong { display: block; margin-top: 10px; font: 600 18px "JetBrains Mono", monospace; }.cost-kind p, .cost-kind small { display: block; margin: 5px 0; color: var(--text-muted); font-size: 9px; line-height: 1.4; }.cost-kind ul { display: grid; gap: 4px; margin: 8px 0 0; padding: 0; list-style: none; }.cost-kind li { display: flex; justify-content: space-between; gap: 8px; font: 9px "JetBrains Mono", monospace; }.cost-kind li span { color: var(--text-muted); font: 9px "Figtree", sans-serif; }
  .cost-note { margin: 9px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.45; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.cost-columns { grid-template-columns: 1fr; } }
</style>
