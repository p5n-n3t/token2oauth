<script lang="ts">
  import type { HistoryConcurrencyPoint, HistoryMetric } from "../../lib/history-types";
  import { formatMetricValue } from "./history-state";
  let { points, peak }: { points: HistoryConcurrencyPoint[]; peak?: HistoryMetric } = $props();
  const width = 560;
  const height = 135;
  const pad = { top: 12, right: 10, bottom: 22, left: 10 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const maximum = $derived(Math.max(1, ...points.map((point) => point.active)));
  const first = $derived(points[0]?.at ?? 0);
  const last = $derived(points[points.length - 1]?.at ?? first);
  const line = $derived(points.map((point) => {
    const x = pad.left + (last === first ? plotWidth / 2 : (point.at - first) / (last - first) * plotWidth);
    const y = pad.top + plotHeight - (point.active / maximum) * plotHeight;
    return String(x) + "," + String(y);
  }).join(" "));
</script>

<section class="panel" aria-labelledby="concurrency-heading">
  <div class="panel-heading"><div><p class="eyebrow">OWNERSHIP / ATTEMPT EVENTS</p><h2 id="concurrency-heading">Concurrency</h2></div><div class="peak"><span>Peak observed</span><strong>{formatMetricValue(peak)}</strong></div></div>
  {#if points.length}
    <div class="chart-scroll"><svg viewBox={"0 0 " + width + " " + height} role="img" aria-label={"Observed active attempt timeline with " + points.length + " ownership changes"}>
      <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight} y2={pad.top + plotHeight} class="axis" />
      <polyline points={line} />
      {#each points as point, index (String(point.at) + ":" + index)}
        {@const x = pad.left + (last === first ? plotWidth / 2 : (point.at - first) / (last - first) * plotWidth)}
        {@const y = pad.top + plotHeight - (point.active / maximum) * plotHeight}
        <circle cx={x} cy={y} r="2.6"><title>{new Date(point.at * 1000).toLocaleString() + ": " + point.active + " active attempts"}</title></circle>
      {/each}
      <text x={pad.left} y={height - 4} class="chart-label">{first ? new Date(first * 1000).toLocaleDateString() : ""}</text>
      <text x={width - pad.right} y={height - 4} text-anchor="end" class="chart-label">{last ? new Date(last * 1000).toLocaleDateString() : ""}</text>
    </svg></div>
  {:else}<div class="empty-chart">No complete concurrency baseline is available for this range.</div>{/if}
  <p class="chart-footnote">A truncated ownership history removes the timeline instead of showing an unreliable starting count.</p>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }.panel-heading { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 10px; }
  .eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 14px; font-weight: 610; }
  .peak { display: grid; gap: 3px; text-align: right; }.peak span { color: var(--text-muted); font-size: 9px; }.peak strong { color: var(--text-primary); font: 600 15px "JetBrains Mono", monospace; }
  .chart-scroll { overflow-x: auto; }svg { display: block; width: 100%; min-width: 350px; height: auto; overflow: visible; }.axis { stroke: var(--border-default); }.chart-label { fill: var(--text-muted); font: 9px "JetBrains Mono", monospace; }
  polyline { fill: none; stroke: var(--accent-blue); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }circle { fill: var(--accent-blue); stroke: var(--bg-surface); stroke-width: 1.2; }
  .empty-chart { min-height: 90px; display: grid; place-items: center; color: var(--text-muted); font-size: 11px; }.chart-footnote { margin: 8px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.45; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; } }
</style>
