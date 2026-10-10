<script lang="ts">
  import DetailDrawer from "../lib/kit/components/DetailDrawer.svelte";
  import Button from "../lib/kit/components/Button.svelte";
  import CircleHelpIcon from "@lucide/svelte/icons/circle-help";
  import ExternalLinkIcon from "@lucide/svelte/icons/external-link";
  import { display, isSafeHttpsReference, formatTimestamp } from "../lib/format";
  import type { Slot, TaskDetail } from "../lib/types";

  interface Props { open: boolean; detail: TaskDetail | null; slot: Slot | null; loading?: boolean; error?: string; onclose: () => void }
  let { open, detail, slot, loading = false, error = "", onclose }: Props = $props();
  const references = $derived((detail?.references ?? []).filter(isSafeHttpsReference));
  const unavailableAction = "This intervention is not supported by the current Snooze control API.";
</script>

{#if open}
  <DetailDrawer title="Task inspection" ariaLabel="Task inspection drawer" onclose={onclose} closeAriaLabel="Close task inspection" width="min(620px, 100vw)">
    {#snippet header()}
      <div class="drawer-heading"><div><span class="eyebrow">ASSIGNMENT / INSPECT</span><strong>{display(detail?.summary, "Task details")}</strong><small class="mono">{display(detail?.task_id, slot?.task_id ?? "Loading task ID")}</small></div><button class="drawer-close kit-control-states" type="button" aria-label="Close task inspection" onclick={onclose}>×</button></div>
    {/snippet}
    <div class="drawer-content" data-testid="task-drawer-content">
      {#if loading && !detail}<div class="drawer-loading" role="status"><span class="loading-mark"></span>Loading task record…</div>{/if}
      {#if error}<p class="stale-banner" role="status">Task details could not be loaded. {error}</p>{/if}
      {#if detail}
        <div class="drawer-state-row"><span class="drawer-state"><i></i>{display(detail.state, "State unknown")}</span><span>Last observed {formatTimestamp(slot?.observed_at)}</span></div>
        <section class="drawer-section"><div class="drawer-section-heading"><h2>Assignment</h2><span>Requested and confirmed values stay separate</span></div><dl class="detail-grid"><div><dt>Account</dt><dd>{display(slot?.account_id)}</dd></div><div><dt>Logical slot</dt><dd>{display(slot?.logical_slot ?? null)}</dd></div><div><dt>Confirmed model</dt><dd>{display(slot?.confirmed_model)}</dd></div><div><dt>Confirmed effort</dt><dd>{display(slot?.confirmed_effort)}</dd></div><div><dt>Requested model</dt><dd>{display(slot?.requested_model)}</dd></div><div><dt>Requested effort</dt><dd>{display(slot?.requested_effort)}</dd></div><div class="detail-wide"><dt>Workspace / assignment scope</dt><dd>{display(slot?.workspace_id)}</dd></div></dl></section>
        <section class="drawer-section"><div class="drawer-section-heading"><h2>Full instructions</h2><span>Literal task text</span></div><pre class="instruction-block">{detail.instruction ?? "Instructions were not included in the available task record."}</pre></section>
        <section class="drawer-section"><div class="drawer-section-heading"><h2>Evidence links</h2><span>{references.length} validated HTTPS references</span></div>
          {#if references.length}<ul class="evidence-links">{#each references as reference (reference)}<li><a href={reference} target="_blank" rel="noopener noreferrer">{reference}<ExternalLinkIcon size={13} aria-hidden="true" /></a></li>{/each}</ul>{:else}<p class="drawer-muted">No safe evidence links were recorded.</p>{/if}
        </section>
        <section class="drawer-section"><div class="drawer-section-heading"><h2>Attempts & events</h2><span>{detail.attempts.length + detail.events.length} records</span></div>
          {#if detail.attempts.length || detail.events.length}
            {#each detail.attempts as attempt, index}<details><summary>Attempt {String(attempt.generation ?? index + 1)} · {String(attempt.state ?? "unknown")}</summary><pre class="instruction-block">{JSON.stringify(attempt,null,2)}</pre></details>{/each}
            {#each detail.events as event}<details><summary>{String(event.kind ?? "Event")} · {formatTimestamp(typeof event.at === "number" ? event.at : null)}</summary><pre class="instruction-block">{JSON.stringify(event,null,2)}</pre></details>{/each}
          {:else}<div class="missing-evidence"><CircleHelpIcon size={16} aria-hidden="true" /><span>No attempt or event timeline was supplied for this task.</span></div>{/if}
        </section>
      {:else if !loading && !error}<div class="drawer-loading">No task detail is available.</div>{/if}
    </div>
    {#snippet footer()}<span class="drawer-footer-note">Use Queue for supported interventions. Resume requires a confirmed adapter capability.</span><button type="button" class="unsupported-action" disabled title={unavailableAction}>Resume</button>{/snippet}
  </DetailDrawer>
{/if}
