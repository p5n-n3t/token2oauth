<script lang="ts">
  import type { NativeHistoryReport } from "../../lib/history-types";
  let { report }: { report: NativeHistoryReport } = $props();
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const calendar = $derived.by(() => {
    const values = new Map<string, number>();
    for (const point of report.series) values.set(point.date, point.events ?? 0);
    for (const point of report.heatmap) values.set(point.date, point.hours.reduce((total, value) => total + value, 0));
    const dates = [...values.keys()].sort();
    if (!dates.length) return { weeks: [] as Array<Array<{ date: string; value: number; level: number } | null>>, months: [] as Array<{ week: number; label: string }> };

    // Adapted weekly-column grouping and month markers from AgentsView's pinned Heatmap.
    const first = new Date(dates[0] + "T00:00:00Z");
    const last = new Date(dates[dates.length - 1] + "T00:00:00Z");
    const start = new Date(first);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(last);
    end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
    const maxValue = Math.max(0, ...values.values());
    const weeks: Array<Array<{ date: string; value: number; level: number } | null>> = [];
    const months: Array<{ week: number; label: string }> = [];
    let monthSeen = "";
    for (let cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      const date = cursor.toISOString().slice(0, 10);
      const weekIndex = Math.floor((cursor.getTime() - start.getTime()) / (7 * 24 * 60 * 60 * 1000));
      weeks[weekIndex] ??= Array(7).fill(null);
      const value = values.get(date);
      if (value !== undefined) {
        weeks[weekIndex]![cursor.getUTCDay()] = { date, value, level: heatLevel(value, maxValue) };
        const monthKey = date.slice(0, 7);
        if (monthKey !== monthSeen && (cursor.getUTCDate() <= 7 || weekIndex === 0)) {
          months.push({ week: weekIndex, label: cursor.toLocaleString("en", { month: "short", timeZone: "UTC" }) });
          monthSeen = monthKey;
        }
      }
    }
    return { weeks, months };
  });

  function heatLevel(value: number, max: number): number {
    if (value <= 0) return 0;
    if (max <= 0) return 1;
    const ratio = value / max;
    return ratio <= .25 ? 1 : ratio <= .5 ? 2 : ratio <= .75 ? 3 : 4;
  }
</script>

<section class="panel" aria-labelledby="calendar-heading">
  <div class="panel-heading"><div><p class="eyebrow">ACTIVITY / LOCAL CALENDAR</p><h2 id="calendar-heading">Event rhythm</h2></div><span class="panel-note">Darker cells mark busier days</span></div>
  {#if calendar.weeks.length}
    <div class="calendar-scroll" role="group" aria-label={"Calendar heatmap of " + report.series.length + " daily Snooze history points"} style:--week-count={calendar.weeks.length}>
      <div class="month-row"><span></span>{#each calendar.weeks as _, index (index)}<span>{calendar.months.find((month) => month.week === index)?.label ?? ""}</span>{/each}</div>
      {#each weekdays as weekday, dayIndex (weekday)}
        <div class="calendar-row"><span class="day-label">{weekday}</span>{#each calendar.weeks as week, weekIndex (weekIndex)}
          {@const cell = week[dayIndex]}
          {#if cell}<span class="heat-cell" role="img" data-level={cell.level} style:--level={cell.level} title={cell.date + ": " + cell.value.toLocaleString() + " events"} aria-label={cell.date + ": " + cell.value.toLocaleString() + " events"}></span>{:else}<span class="heat-cell empty-cell" aria-hidden="true"></span>{/if}
        {/each}</div>
      {/each}
    </div>
    {#if report.coverage.truncated}<p class="chart-footnote">This calendar reflects a bounded sample; one or more source rows were truncated.</p>{/if}
  {:else}<div class="empty-chart">No dated event activity is available for this range.</div>{/if}
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }
  .panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }
  h2 { margin: 0; font-size: 14px; font-weight: 610; letter-spacing: -.02em; }.panel-note { color: var(--text-muted); font-size: 9px; }
  .calendar-scroll { overflow-x: auto; padding: 0 0 3px; }
  .month-row, .calendar-row { display: grid; grid-template-columns: 28px repeat(var(--week-count), 13px); gap: 3px; width: max-content; }
  .month-row { margin-bottom: 4px; color: var(--text-muted); font-size: 8px; line-height: 12px; }.calendar-row { align-items: center; margin-bottom: 3px; }.day-label { color: var(--text-muted); font-size: 8px; }
  .heat-cell { width: 13px; height: 13px; border: 1px solid color-mix(in srgb, var(--border-muted) 75%, transparent); border-radius: 3px; background: var(--bg-inset); }
  .heat-cell[data-level="1"] { background: color-mix(in srgb, var(--accent-lavender) 23%, var(--bg-inset)); }.heat-cell[data-level="2"] { background: color-mix(in srgb, var(--accent-lavender) 43%, var(--bg-inset)); }.heat-cell[data-level="3"] { background: color-mix(in srgb, var(--accent-lavender) 66%, var(--bg-inset)); }.heat-cell[data-level="4"] { background: color-mix(in srgb, var(--accent-lavender) 88%, var(--bg-inset)); }.empty-cell { opacity: .4; }
  .chart-footnote, .empty-chart { margin: 8px 0 0; color: var(--text-muted); font-size: 9px; line-height: 1.45; }.empty-chart { min-height: 100px; display: grid; place-items: center; font-size: 11px; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; flex-direction: column; } }
</style>
