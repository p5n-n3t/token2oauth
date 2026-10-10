<script lang="ts">
  import { HISTORY_FILTER_VALUE_LIMIT } from "../../lib/history-types";

  interface Props { label: string; values: string[]; options: string[]; onchange: (values: string[]) => void }
  let { label, values, options, onchange }: Props = $props();

  function toggle(value: string, checked: boolean) {
    if (checked && values.length >= HISTORY_FILTER_VALUE_LIMIT && !values.includes(value)) return;
    const next = checked ? [...values, value] : values.filter((item) => item !== value);
    onchange([...new Set(next)]);
  }
</script>

<details class="multi-filter">
  <summary aria-label={label + " filter, " + (values.length ? values.length + " selected" : "all selected")}>
    <span>{label}</span><b>{values.length ? String(values.length) : "All"}</b><i aria-hidden="true">⌄</i>
  </summary>
  <fieldset>
    <legend>{label}</legend>
    {#if options.length}
      {#each options as option (option)}
        <label><input type="checkbox" checked={values.includes(option)} disabled={!values.includes(option) && values.length >= HISTORY_FILTER_VALUE_LIMIT} onchange={(event) => toggle(option, event.currentTarget.checked)} /><span>{option}</span></label>
      {/each}
    {:else}<p>No recorded values to filter.</p>{/if}
    {#if values.length >= HISTORY_FILTER_VALUE_LIMIT && options.some((option) => !values.includes(option))}
      <p role="status">Choose up to {HISTORY_FILTER_VALUE_LIMIT} values. Clear a selection to choose another.</p>
    {/if}
    {#if values.length}<button type="button" class="clear-filter" onclick={() => onchange([])}>Clear selection</button>{/if}
  </fieldset>
</details>

<style>
  .multi-filter { position: relative; min-width: 0; }
  summary { height: 35px; display: flex; align-items: center; gap: 8px; padding: 0 10px; list-style: none; border: 1px solid var(--border-default); border-radius: 6px; color: var(--text-secondary); background: var(--bg-surface); font-size: 10px; cursor: pointer; }
  summary::-webkit-details-marker { display: none; } summary:hover { border-color: var(--accent-cyan); color: var(--text-primary); }
  summary span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } summary b { margin-left: auto; color: var(--accent-cyan); font-size: 9px; font-weight: 600; } summary i { color: var(--text-muted); font-style: normal; }
  fieldset { position: absolute; z-index: 4; top: calc(100% + 5px); left: 0; width: max(100%, 190px); max-height: 260px; overflow-y: auto; display: grid; gap: 5px; margin: 0; padding: 11px; border: 1px solid var(--border-default); border-radius: 7px; background: var(--bg-surface-raised); box-shadow: var(--shadow-lg); }
  legend { padding: 0 4px; color: var(--text-muted); font-size: 9px; font-weight: 650; }
  label { min-width: 0; display: flex; align-items: center; gap: 8px; padding: 5px 4px; color: var(--text-secondary); font-size: 10px; cursor: pointer; }
  label span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } input { accent-color: var(--accent-cyan); }
  fieldset p { margin: 5px 2px; color: var(--text-muted); font-size: 10px; }.clear-filter { justify-self: start; margin-top: 3px; padding: 5px 2px; border: 0; color: var(--accent-cyan); background: transparent; font-size: 9px; cursor: pointer; }
</style>
