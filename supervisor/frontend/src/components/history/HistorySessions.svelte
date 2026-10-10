<script lang="ts">
  import type { HistoryTopSession } from "../../lib/history-types";
  let { sessions }: { sessions: HistoryTopSession[] } = $props();
</script>

<section class="panel" aria-labelledby="sessions-heading">
  <div class="panel-heading"><div><p class="eyebrow">USAGE / SOURCE SESSION IDS</p><h2 id="sessions-heading">Top observed sessions</h2></div><span class="panel-note">Ranked by recorded input + output tokens</span></div>
  {#if sessions.length}
    <div class="table-scroll"><table><thead><tr><th scope="col">Session</th><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Reported cost</th></tr></thead><tbody>
      {#each sessions.slice(0, 10) as session (session.session_id)}
        <tr><th scope="row"><code>{session.session_id}</code></th><td>{session.model ?? "Unavailable"}</td><td>{session.input_tokens.toLocaleString()}</td><td>{session.output_tokens.toLocaleString()}</td><td>{#if session.observed_costs.length}{#each session.observed_costs as cost (cost.currency)}<span>{cost.value.toLocaleString(undefined, { maximumFractionDigits: 4 })} {cost.currency}</span>{/each}{:else}<span class="muted">Unavailable</span>{/if}</td></tr>
      {/each}
    </tbody></table></div>
    <p class="panel-note footnote">Session IDs come from imported usage evidence. The native report includes no task relationship for these rows, so there is no task Inspect action.</p>
  {:else}<div class="empty-chart">No source session IDs with usage facts are available.</div>{/if}
</section>

<style>
  .panel { min-width: 0; padding: 17px 18px 14px; border: 1px solid var(--border-default); border-radius: 9px; background: var(--bg-surface); }.panel-heading { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; margin-bottom: 12px; }.eyebrow { margin: 0 0 5px; color: var(--text-muted); font-size: 9px; font-weight: 700; letter-spacing: .12em; }h2 { margin: 0; font-size: 14px; font-weight: 610; }.panel-note { color: var(--text-muted); font-size: 9px; }
  .table-scroll { overflow-x: auto; }table { width: 100%; border-collapse: collapse; text-align: left; font-size: 9px; }th, td { padding: 9px 6px; border-bottom: 1px solid var(--border-muted); white-space: nowrap; }thead th { color: var(--text-muted); font-size: 8px; font-weight: 600; }tbody th { color: var(--text-primary); font-weight: 500; }code { display: inline-block; max-width: 200px; overflow: hidden; color: var(--accent-cyan); font: 9px "JetBrains Mono", monospace; text-overflow: ellipsis; vertical-align: bottom; }td { color: var(--text-secondary); font-family: "JetBrains Mono", monospace; }td span { display: block; }.muted { color: var(--text-muted); font-family: "Figtree", sans-serif; }.footnote { margin: 8px 0 0; line-height: 1.4; }
  .empty-chart { min-height: 90px; display: grid; place-items: center; color: var(--text-muted); font-size: 11px; }
  @media (max-width: 560px) { .panel { padding: 14px 12px 12px; }.panel-heading { align-items: flex-start; flex-direction: column; } }
</style>
