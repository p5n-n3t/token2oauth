<script lang="ts">
  import type { HistorySeriesPoint } from "../../lib/history-types";
  let { points }: { points: HistorySeriesPoint[] } = $props();
  const width = 560;
  const height = 148;
  const pad = { top: 14, right: 12, bottom: 24, left: 12 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const max = $derived(Math.max(1, ...points.map((point) => Math.max(point.events, point.validated))));
  const eventPoints = $derived(points.map((point, index) => {
    const x = pad.left + (points.length < 2 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
    const y = pad.top + plotHeight - (point.events / max) * plotHeight;
    return String(x) + "," + String(y);
  }).join(" "));
  const validatedPoints = $derived(points.map((point, index) => {
    const x = pad.left + (points.length < 2 ? plotWidth / 2 : index / (points.length - 1) * plotWidth);
    const y = pad.top + plotHeight - (point.validated / max) * plotHeight;
    return String(x) + "," + String(y);
  }).join(" "));
</script>

<section class="panel trend-panel" aria-labelledby="trend-heading">
  <div class="panel-heading"><div><p class="eyebrow">ACTIVITY / LOCAL DAYS</p><h2 id="trend-heading">Throughput &amp; events</h2></div><div class="legend"><span><i class="legend-events"></i>Events</span><span><i class="legend-validated"></i>Validated</span></div></div>
  {#if points.length}
    <div class="trend-scroll">
      <svg viewBox={"0 0 " + width + " " + height} role="img" aria-label={"Daily Snooze events and validated completions over " + points.length + " dates"}>
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight} y2={pad.top + plotHeight} class="axis" />
        <line x1={pad.left} x2={width - pad.right} y1={pad.top + plotHeight / 2} y2={pad.top + plotHeight / 2} class="gridline" />
        <polyline points={eventPoints} class="events-line" /><polyline points={validatedPoints} class="validated-line" />
        {#each points as point, index (point.date)}
          {@const x = pad.left + (points.length < 2 ? plotWidth / 2 : index / (points.length - 1) * plotWidth)}
          {@const eventY = pad.top + plotHeight - (point.events / max) * plotHeight}
          {@const validatedY = pad.top + plotHeight - (point.validated / max) * plotHeight}
          <circle cx={x} cy={eventY} r="2.8" class="events-dot"><title>{point.date + ": " + point.events.toLocaleString() + " events"}</title></circle>
          <circle cx={x} cy={validatedY} r="2.8" class="validated-dot"><title>{point.date + ": " + point.validated.toLocaleString() + " validated completions"}</title></circle>
        {/each}
        <text x={pad.left} y={height - 5} class="chart-label">{points[0]?.date}</text>
        <text x={width - pad.right} y={height - 5} text-anchor="end" class="chart-label">{points.at(-1)?.date}</text>
      </svg>
    </div>
  {:else}<div class="empty-chart">No local event series is available for this range.</div>{/if}
  <p class="chart-footnote">Validated throughput counts only completion events with a recorded valid outcome. Event volume remains a separate measure.</p>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }
  .panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }
  h2 { margin: 0; font-size: 14px; font-weight: 610; letter-spacing: -.02em; }
  .legend { display: flex; gap: 12px; color: var(--text-muted); font-size: 9px; white-space: nowrap; }.legend span { display: inline-flex; align-items: center; gap: 5px; }
  .legend i { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-cyan); }.legend .legend-validated { background: var(--accent-lavender); }
  .trend-scroll { width: 100%; overflow-x: auto; } svg { display: block; width: 100%; min-width: 380px; height: auto; overflow: visible; }
  .axis { stroke: var(--border-default); stroke-width: 1; }.gridline { stroke: var(--border-muted); stroke-dasharray: 3 5; }
  polyline { fill: none; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }.events-line { stroke: var(--accent-cyan); }.validated-line { stroke: var(--accent-lavender); }
  circle { stroke: var(--bg-surface); stroke-width: 1.3; }.events-dot { fill: var(--accent-cyan); }.validated-dot { fill: var(--accent-lavender); }.chart-label { fill: var(--text-muted); font: 9px "JetBrains Mono", monospace; }
  .empty-chart { min-height: 100px; display: grid; place-items: center; color: var(--text-muted); font-size: 11px; }.chart-footnote { margin: 8px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.45; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; flex-direction: column; } }
</style>
