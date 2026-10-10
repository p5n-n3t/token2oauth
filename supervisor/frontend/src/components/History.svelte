<script lang="ts">
  import SearchInput from "../lib/kit/components/SearchInput.svelte";
  import Table from "../lib/kit/components/Table.svelte";
  import TableHeaderCell from "../lib/kit/components/TableHeaderCell.svelte";
  import { display, formatTimestamp } from "../lib/format";
  import type { HistoryEntry } from "../lib/types";

  interface Props {
    entries: HistoryEntry[]; total: number; offset: number; limit: number; query: string;
    loading: boolean; error: string; oninspect?: (taskId: string) => void;
    onpage: (offset: number) => void; onsearch: (query: string) => void;
  }
  let { entries, total, offset, limit, query, loading, error, oninspect = () => undefined, onpage, onsearch }: Props = $props();
  let queryValue = $state("");
  $effect(() => { queryValue = query; });
  const page = $derived(Math.floor(offset / limit));
  const pageCount = $derived(Math.max(1, Math.ceil(total / limit)));
  const end = $derived(Math.min(offset + entries.length, total));
</script>

<section class="page-view history-view" data-testid="history-view" aria-labelledby="history-title">
  <div class="page-heading">
    <div><p class="eyebrow">LOCAL EVIDENCE / RECORDED OUTCOMES</p><h1 id="history-title">History<span class="heading-period">.</span></h1><p class="page-subtitle">What Snooze has recorded, with missing usage and validation fields called out.</p></div>
    <div class="history-total"><strong>{total.toLocaleString()}</strong><span>available records</span></div>
  </div>
  <div class="history-provenance"><span class="provenance-mark">i</span><p><strong>Source: local Snooze history.</strong> Provider tokens, credit usage, cost and rich validation analytics have not been imported. Missing values remain unavailable.</p></div>
  {#if error}<p class="stale-banner" role="status">History refresh failed. Previously loaded records remain visible. {error}</p>{/if}
  <div class="history-toolbar"><SearchInput value={queryValue} oninput={(value) => { queryValue = value; onsearch(value); }} placeholder="Find a task or recorded event" ariaLabel="Search history" block /><span>{loading ? "Loading records…" : "Usage analytics unavailable"}</span></div>
  <div class="queue-results-bar"><span>Showing {total ? offset + 1 : 0}–{end} of {total.toLocaleString()} records</span><span>Latest available evidence first · fetched {entries.length} at a time</span></div>
  <div class="history-table-frame">
    <Table ariaLabel="Snooze history records" class="history-table">
      {#snippet header()}<TableHeaderCell label="Recorded" /><TableHeaderCell label="Outcome / event" /><TableHeaderCell label="Task" /><TableHeaderCell label="Evidence and coverage" />{/snippet}
      {#snippet children()}
        {#each entries as entry (entry.id)}
          <tr data-testid="history-row">
            <td class="mono history-date">{formatTimestamp(entry.at)}</td>
            <td><span class="history-kind" data-kind={entry.kind}>{entry.kind}</span></td>
            <td><strong>{entry.title}</strong>{#if entry.task_id}<small class="table-subline mono">{entry.task_id}</small>{/if}</td>
            <td class="history-detail">{entry.detail}{#if entry.task_id}<button type="button" class="history-inspect" onclick={() => oninspect(entry.task_id!)}>Inspect</button>{/if}</td>
          </tr>
        {/each}
      {/snippet}
    </Table>
    {#if !entries.length && !loading}<div class="empty-table"><strong>{query ? "No records match this search" : "No local history is available"}</strong><span>Nothing is counted as zero when Snooze has no source data.</span></div>{/if}
  </div>
  <div class="pagination"><span>Page {page + 1} of {pageCount}</span><div><button class="page-button kit-control-states" type="button" aria-label="Previous page" disabled={offset === 0 || loading} onclick={() => onpage(Math.max(0, offset - limit))}>‹</button><button class="page-button kit-control-states" type="button" aria-label="Next page" disabled={offset + limit >= total || loading} onclick={() => onpage(offset + limit)}>›</button></div></div>
</section>
