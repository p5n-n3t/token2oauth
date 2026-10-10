<script lang="ts">
  import SearchInput from "../lib/kit/components/SearchInput.svelte";
  import Table from "../lib/kit/components/Table.svelte";
  import TableHeaderCell from "../lib/kit/components/TableHeaderCell.svelte";
  import Button from "../lib/kit/components/Button.svelte";
  import type { ControlReceipt } from "../lib/api";
  import type { DashboardState, QueueTask } from "../lib/types";

  interface Props {
    dashboard: DashboardState; tasks: QueueTask[]; total: number; offset: number; limit: number; loading: boolean; error: string;
    onpage: (offset: number) => void; oninspect: (taskId: string) => void;
    oncontrol: (action: string, target: string, values: Record<string, unknown>, revision: number) => Promise<ControlReceipt | null> | void;
  }
  let { dashboard, tasks, total, offset, limit, loading, error, onpage, oninspect, oncontrol }: Props = $props();
  let query = $state("");
  let addOpen = $state(false);
  let taskId = $state("");
  let scopeKeys = $state("");
  let inputRef = $state("");
  let inputHash = $state("");
  let outputIds = $state("");
  let outputFields = $state("");
  let model = $state("");
  let effort = $state("low");
  let instructions = $state("");
  let dependencies = $state("");
  const activeIds = $derived(new Set(dashboard.slots.filter((slot) => slot.task_id && ["running", "waiting", "queued", "starting", "cancel_pending", "awaiting_output", "ambiguous"].includes((slot.task_state ?? "").toLowerCase())).map((slot) => slot.task_id!)));
  const needle = $derived(query.trim().toLowerCase());
  const visible = $derived(needle ? tasks.filter((task) => [task.id, task.summary, task.state].some((value) => value.toLowerCase().includes(needle))) : tasks);
  const pageCount = $derived(Math.max(1, Math.ceil(total / limit)));
  const projectManaged = $derived(dashboard.capabilities.dispatch.supported);
  const parsedScopeKeys = $derived(scopeKeys.split(",").map((item) => item.trim()).filter(Boolean));
  const parsedOutputIds = $derived(outputIds.split(",").map((item) => item.trim()).filter(Boolean));
  const parsedFields = $derived(outputFields.split(",").map((item) => item.trim()).filter(Boolean));
  const packetValid = $derived(
    /^[A-Za-z0-9_-]{1,120}$/.test(taskId.trim()) && parsedScopeKeys.length > 0 && inputRef.trim().length > 0 &&
    /^[a-fA-F0-9]{64}$/.test(inputHash.trim()) && parsedOutputIds.length > 0 && parsedOutputIds.length === parsedScopeKeys.length &&
    parsedOutputIds.every((id) => parsedScopeKeys.includes(id)) && parsedFields.length > 0 && model.trim().length > 0 && instructions.trim().length > 0,
  );

  function isActive(task: QueueTask) { return activeIds.has(task.id); }
  function accountFor(task: QueueTask) {
    const slot = dashboard.slots.find((candidate) => candidate.task_id === task.id);
    return dashboard.accounts.find((candidate) => candidate.id === slot?.account_id || candidate.server_key === slot?.account_id);
  }
  function taskReason(task: QueueTask, action: string): string {
    if (isActive(task)) return "This task currently owns an active execution scope; reconcile it before editing or retrying.";
    if (!projectManaged && ["retry", "resume"].includes(action)) return "Project is externally managed; provider mutation is unavailable.";
    if (dashboard.settings.emergency_stop && ["retry", "resume"].includes(action)) return "Emergency stop is active; new dispatch is blocked.";
    if (!task.approved && ["retry", "resume"].includes(action)) return "Task is not approved.";
    return "";
  }
  function retryValues() { return dashboard.settings.pause_dispatch ? { override_pause: true } : {}; }
  function retryLabel() { return dashboard.settings.pause_dispatch ? "Retry once" : "Retry"; }
  function retryTitle() { return dashboard.settings.pause_dispatch ? "One-time pause override only; emergency stop, budgets and active ownership still apply." : "Retry approved, inactive work."; }
  async function submitDraft() {
    if (!packetValid) return;
    const receipt = await oncontrol("task-add", dashboard.project.id, {
      id: taskId.trim(), scope_keys: parsedScopeKeys, input_ref: inputRef.trim(), input_hash: inputHash.trim().toLowerCase(),
      requirements: { model: model.trim(), effort }, output_contract: { ids: parsedOutputIds, fields: parsedFields },
      validator_id: "json-records", instructions: instructions.trim(), dependencies: dependencies.split(",").map((item) => item.trim()).filter(Boolean),
    }, 0);
    if (receipt?.state === "confirmed") addOpen = false;
  }
</script>

<section class="page-view queue-view" data-testid="queue-view" aria-labelledby="queue-title">
  <div class="page-heading">
    <div><p class="eyebrow">TASKS / BOUNDED CONTROL QUEUE</p><h1 id="queue-title">Queue<span class="heading-period">.</span></h1><p class="page-subtitle">Inspect task packets and use revision-checked coordinator actions.</p></div>
    <div class="queue-total"><strong>{total.toLocaleString()}</strong><span>tasks in coordinator queue</span></div>
  </div>
  <div class="queue-toolbar"><SearchInput bind:value={query} placeholder="Search this loaded page" ariaLabel="Search assignments" block class="queue-search" /><Button tone="info" surface="solid" onclick={() => (addOpen = !addOpen)}>{addOpen ? "Close draft form" : "Add task draft"}</Button></div>
  {#if error}<p class="stale-banner" role="status">Queue could not refresh; the last loaded page remains visible. {error}</p>{/if}
  {#if addOpen}
    <section class="task-draft-form" aria-labelledby="draft-title" data-testid="task-draft-form">
      <div class="account-editor-heading"><div><span class="eyebrow">STRUCTURED PACKET / SAVED AS DRAFT</span><h2 id="draft-title">Add task draft</h2></div></div>
      <p class="form-help">This form stores a validated task packet; it does not run shell commands. Input must be an immutable reference with its SHA-256 hash, and output record IDs must exactly match scoped record IDs.</p>
      <div class="policy-form-grid">
        <label>Task ID<input bind:value={taskId} aria-label="Task ID" /></label>
        <label>Scope record IDs<input bind:value={scopeKeys} aria-label="Scope record IDs" placeholder="record:1, record:2" /></label>
        <label>Input reference<input bind:value={inputRef} aria-label="Input reference" /></label>
        <label>Input SHA-256<input bind:value={inputHash} aria-label="Input SHA-256" placeholder="64 hexadecimal characters" /></label>
        <label>Output record IDs<input bind:value={outputIds} aria-label="Output record IDs" /></label>
        <label>Output fields<input bind:value={outputFields} aria-label="Output fields" placeholder="status, summary" /></label>
        <label>Required model<input bind:value={model} aria-label="Required model" /></label>
        <label>Required effort<select bind:value={effort} aria-label="Required effort"><option>low</option><option>medium</option><option>high</option></select></label>
        <label class="draft-instructions">Task instructions<textarea bind:value={instructions} aria-label="Task instructions" rows="4"></textarea></label>
        <label>Dependencies<input bind:value={dependencies} aria-label="Dependencies" placeholder="task-id, task-id" /></label>
      </div>
      <div class="account-editor-footer"><Button tone="info" surface="solid" disabled={!packetValid || loading} onclick={submitDraft}>Save draft packet</Button></div>
    </section>
  {/if}
  <div class="queue-results-bar"><span>Showing {total ? offset + 1 : 0}–{Math.min(offset + tasks.length, total)} of {total.toLocaleString()} tasks</span><span>{loading ? "Loading server page…" : `Server page size ${limit}`}</span></div>
  <div class="queue-table-frame">
    <Table ariaLabel="Snooze task queue" class="queue-table">
      {#snippet header()}<TableHeaderCell label="Task" /><TableHeaderCell label="State / approval" /><TableHeaderCell label="Priority" /><TableHeaderCell label="Actions" />{/snippet}
      {#snippet children()}
        {#each visible as task (task.id)}
          {@const active = isActive(task)}
          {@const retryReason = taskReason(task, "retry")}
          {@const account = accountFor(task)}
          <tr data-testid="queue-row" data-task-id={task.id}>
            <td><div class="queue-assignment"><strong>{task.summary}</strong><small class="mono">{task.id}</small></div></td>
            <td><span class="queue-state">{task.state}</span><small class="table-subline">{task.approved ? "Approved" : "Draft"}{active ? " · active ownership" : ""}</small></td>
            <td><strong>{task.priority}</strong></td>
            <td><div class="queue-actions queue-actions-wrap">
              <Button size="sm" onclick={() => oninspect(task.id)}>Inspect</Button>
              {#if !task.approved}<Button size="sm" disabled={active || loading} title={active ? taskReason(task, "approve") : "Approve this draft task."} onclick={() => oncontrol("approve", task.id, {}, task.revision)}>Approve</Button>{/if}
              <Button size="sm" disabled={active || loading} title={active ? taskReason(task, "hold") : "Hold this inactive task."} onclick={() => oncontrol("hold", task.id, {}, task.revision)}>Hold</Button>
              <Button size="sm" disabled={active || loading} title={active ? taskReason(task, "prioritize") : "Raise task priority by one."} onclick={() => oncontrol("prioritize", task.id, { priority: task.priority + 1 }, task.revision)}>Prioritize</Button>
              {#if active}<Button size="sm" disabled={!projectManaged || !account?.capabilities?.cancel?.supported || loading} title={account?.capabilities?.cancel?.reason ?? (projectManaged ? "Provider has not confirmed cancellation capability." : dashboard.capabilities.dispatch.reason)} onclick={() => oncontrol("cancel", task.id, {}, task.revision)}>Cancel</Button>
              {:else}<Button size="sm" disabled={Boolean(retryReason) || loading} title={retryReason || retryTitle()} onclick={() => oncontrol("retry", task.id, retryValues(), task.revision)}>{retryLabel()}</Button>{/if}
              <button type="button" class="unsupported-action" disabled title="Reassignment needs confirmed inactive ownership and a new approved routing requirement; direct account reassignment is not supported." aria-label="Reassign">Reassign</button>
            </div></td>
          </tr>
        {/each}
      {/snippet}
    </Table>
    <div class="mobile-task-list">
      {#each visible as task (task.id)}
        {@const active = isActive(task)}
        {@const retryReason = taskReason(task, "retry")}
        {@const account = accountFor(task)}
        <article class="mobile-task-card" data-testid="queue-mobile-row" data-task-id={task.id}>
          <strong>{task.summary}</strong><small class="mono">{task.id}</small>
          <div class="mobile-assignment-meta"><span>{task.state} · {task.approved ? "Approved" : "Draft"}</span><span>Priority {task.priority}</span></div>
          {#if active}<small class="task-ownership-note">Active execution owns its scope.</small>{/if}
          <div class="queue-actions queue-actions-wrap">
            <Button size="sm" onclick={() => oninspect(task.id)}>Inspect</Button>
            {#if !task.approved}<Button size="sm" disabled={active || loading} title={active ? taskReason(task, "approve") : "Approve this draft task."} onclick={() => oncontrol("approve", task.id, {}, task.revision)}>Approve</Button>{/if}
            <Button size="sm" disabled={active || loading} title={active ? taskReason(task, "hold") : "Hold this inactive task."} onclick={() => oncontrol("hold", task.id, {}, task.revision)}>Hold</Button>
            <Button size="sm" disabled={active || loading} title={active ? taskReason(task, "prioritize") : "Raise task priority by one."} onclick={() => oncontrol("prioritize", task.id, { priority: task.priority + 1 }, task.revision)}>Prioritize</Button>
            {#if active}<Button size="sm" disabled={!projectManaged || !account?.capabilities?.cancel?.supported || loading} title={account?.capabilities?.cancel?.reason ?? (projectManaged ? "Provider has not confirmed cancellation capability." : dashboard.capabilities.dispatch.reason)} onclick={() => oncontrol("cancel", task.id, {}, task.revision)}>Cancel</Button>
            {:else}<Button size="sm" disabled={Boolean(retryReason) || loading} title={retryReason || retryTitle()} onclick={() => oncontrol("retry", task.id, retryValues(), task.revision)}>{retryLabel()}</Button>{/if}
            <button type="button" class="unsupported-action" disabled title="Reassignment needs confirmed inactive ownership and a new approved routing requirement; direct account reassignment is not supported." aria-label="Reassign">Reassign</button>
          </div>
        </article>
      {/each}
    </div>
    {#if !visible.length}<div class="empty-table"><strong>{query ? "No tasks match this loaded page" : "No tasks in the coordinator queue"}</strong><span>Task search is bounded to the current server page. Use page controls to inspect more records.</span></div>{/if}
  </div>
  <div class="pagination"><span>Page {Math.floor(offset / limit) + 1} of {pageCount}</span><div><button class="page-button kit-control-states" type="button" aria-label="Previous page" disabled={offset === 0 || loading} onclick={() => onpage(Math.max(0, offset - limit))}>‹</button><button class="page-button kit-control-states" type="button" aria-label="Next page" disabled={offset + limit >= total || loading} onclick={() => onpage(offset + limit)}>›</button></div></div>
</section>
