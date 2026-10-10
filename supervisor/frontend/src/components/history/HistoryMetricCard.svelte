<script lang="ts">
  import type { HistoryMetric } from "../../lib/history-types";
  import { coverageLabel, formatMetricValue } from "./history-state";

  interface Props { label: string; metric?: HistoryMetric; detail?: string }
  let { label, metric, detail }: Props = $props();
</script>

<article class="metric-card" class:metric-unavailable={metric?.state === "unavailable"}>
  <div class="metric-topline"><span>{label}</span><span class="state-mark" data-state={metric?.state ?? "unavailable"}>{metric?.state ?? "unavailable"}</span></div>
  <strong>{formatMetricValue(metric)}</strong>
  <p>{detail ?? metric?.source ?? "No source reported for this value."}</p>
  {#if metric}<small>{coverageLabel(metric.coverage)}</small>{:else}<small>Coverage unavailable</small>{/if}
</article>

<style>
  .metric-card { min-width: 0; padding: 14px 15px 13px; border: 1px solid var(--border-default); border-radius: 8px; background: var(--bg-surface); }
  .metric-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--text-muted); font-size: 10px; }
  .metric-topline > span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .state-mark { color: var(--accent-green); font-size: 9px; text-transform: capitalize; }
  .state-mark[data-state="partial"] { color: var(--accent-amber); }.state-mark[data-state="unavailable"] { color: var(--text-muted); }
  .metric-card > strong { display: block; margin-top: 10px; color: var(--text-primary); font-family: "JetBrains Mono", ui-monospace, monospace; font-size: clamp(19px, 2.3vw, 26px); font-weight: 620; letter-spacing: -.05em; }
  .metric-card p { min-height: 27px; margin: 6px 0 7px; color: var(--text-secondary); font-size: 10px; line-height: 1.4; }
  .metric-card small { color: var(--text-muted); font-size: 9px; line-height: 1.4; }
  .metric-unavailable { background: color-mix(in srgb, var(--bg-surface) 72%, var(--bg-inset)); }
</style>
