<script lang="ts">
  import type { HistoryHourOfWeek } from "../../lib/history-types";
  let { cells }: { cells: HistoryHourOfWeek[] } = $props();
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hours = Array.from({ length: 24 }, (_, hour) => hour);
  // Adapted from AgentsView's pinned weekday/hour lookup and four-level intensity mapping.
  const grid = $derived.by(() => {
    const lookup = new Map(cells.map((cell) => [String(cell.weekday) + ":" + String(cell.hour), cell.events]));
    const maximum = Math.max(0, ...cells.map((cell) => cell.events));
    return days.map((day, weekday) => ({
      day,
      cells: hours.map((hour) => {
        const value = lookup.get(String(weekday) + ":" + String(hour)) ?? 0;
        return { hour, value, level: heatLevel(value, maximum) };
      }),
    }));
  });
  function heatLevel(value: number, max: number): number {
    if (value <= 0) return 0;
    if (max <= 0) return 1;
    const ratio = value / max;
    return ratio <= .25 ? 1 : ratio <= .5 ? 2 : ratio <= .75 ? 3 : 4;
  }
</script>

<section class="panel hour-panel" aria-labelledby="hour-heading">
  <div class="panel-heading"><div><p class="eyebrow">ACTIVITY / WEEKDAY &amp; HOUR</p><h2 id="hour-heading">When Snooze is active</h2></div><span class="panel-note">Timezone: report setting</span></div>
  <div class="hour-grid" role="group" aria-label="Events arranged by weekday and local hour">
    <div class="hour-head"><span></span>{#each hours as hour}<span>{hour % 3 === 0 ? String(hour).padStart(2, "0") : ""}</span>{/each}</div>
    {#each grid as row (row.day)}
      <div class="hour-row"><span class="day-label">{row.day}</span>{#each row.cells as cell (cell.hour)}<span class="hour-cell" role="img" data-level={cell.level} style:--level={cell.level} title={row.day + " " + String(cell.hour).padStart(2, "0") + ":00 — " + cell.value.toLocaleString() + " events"} aria-label={row.day + " " + String(cell.hour).padStart(2, "0") + ":00: " + cell.value.toLocaleString() + " events"}></span>{/each}</div>
    {/each}
  </div>
  <p class="chart-footnote">Intensity uses the observed event count in each selected local weekday/hour bucket. Empty cells mean no matching events were recorded.</p>
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }
  .panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }
  h2 { margin: 0; font-size: 14px; font-weight: 610; letter-spacing: -.02em; }.panel-note { color: var(--text-muted); font-size: 9px; }
  .hour-grid { width: 100%; overflow-x: auto; }.hour-head, .hour-row { display: grid; grid-template-columns: 34px repeat(24, minmax(8px, 1fr)); gap: 2px; min-width: 440px; }
  .hour-head { margin-bottom: 5px; color: var(--text-muted); font: 8px "JetBrains Mono", monospace; text-align: center; }.hour-row { align-items: center; margin-bottom: 3px; }.day-label { color: var(--text-muted); font-size: 8px; }
  .hour-cell { min-width: 0; height: 13px; border: 1px solid color-mix(in srgb, var(--border-muted) 70%, transparent); border-radius: 2px; background: var(--bg-inset); }.hour-cell[data-level="1"] { background: color-mix(in srgb, var(--accent-cyan) 23%, var(--bg-inset)); }.hour-cell[data-level="2"] { background: color-mix(in srgb, var(--accent-cyan) 43%, var(--bg-inset)); }.hour-cell[data-level="3"] { background: color-mix(in srgb, var(--accent-cyan) 66%, var(--bg-inset)); }.hour-cell[data-level="4"] { background: color-mix(in srgb, var(--accent-cyan) 88%, var(--bg-inset)); }
  .chart-footnote { margin: 8px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.45; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; flex-direction: column; } }
</style>
