<script lang="ts">
  import type { Snippet } from "svelte";
  import ActivityIcon from "@lucide/svelte/icons/activity";
  import ListChecksIcon from "@lucide/svelte/icons/list-checks";
  import ServerIcon from "@lucide/svelte/icons/server";
  import HistoryIcon from "@lucide/svelte/icons/history";
  import SettingsIcon from "@lucide/svelte/icons/settings-2";
  import MoonIcon from "@lucide/svelte/icons/moon";
  import SunIcon from "@lucide/svelte/icons/sun";
  import snoozeLogo from "../assets/snooze-logo-concept-v1.png";
  import SelectDropdown from "../lib/kit/components/SelectDropdown.svelte";
  import type { PageKey } from "../lib/types";

  interface Props {
    active: PageKey;
    projectName: string;
    connectionLabel: string;
    theme: "dark" | "light";
    children: Snippet;
    onnav: (page: PageKey) => void;
    ontoggleTheme: () => void;
  }

  let { active, projectName, connectionLabel, theme, children, onnav, ontoggleTheme }: Props = $props();

  const pages = [
    { key: "watch", label: "Watch", icon: ActivityIcon },
    { key: "queue", label: "Queue", icon: ListChecksIcon },
    { key: "providers", label: "Providers", icon: ServerIcon },
    { key: "history", label: "History", icon: HistoryIcon },
    { key: "settings", label: "Settings", icon: SettingsIcon },
  ] as const;
  const projects = $derived([{ value: projectName, label: projectName }]);
</script>

<div class="command-shell">
  <aside class="rail" aria-label="Snooze navigation">
    <a href="#watch" class="brand" onclick={(event) => { event.preventDefault(); onnav("watch"); }} aria-label="Snooze Watch">
      <img src={snoozeLogo} alt="" />
    </a>
    <div class="rail-project">
      <span class="rail-label">PROJECT</span>
      <SelectDropdown value={projectName} options={projects} onchange={() => undefined} title="Project" disabled={projects.length < 2} />
    </div>
    <nav class="primary-nav" aria-label="Command centre">
      {#each pages as page (page.key)}
        <button
          class:active={active === page.key}
          class="nav-item kit-control-states"
          type="button"
          aria-current={active === page.key ? "page" : undefined}
          data-testid={`nav-${page.key}`}
          onclick={() => onnav(page.key)}
        >
          <page.icon size={17} strokeWidth={1.8} aria-hidden="true" />
          <span>{page.label}</span>
          {#if page.key === "watch"}<span class="nav-pip" aria-hidden="true"></span>{/if}
        </button>
      {/each}
    </nav>
    <div class="rail-footer">
      <div class="rail-status"><span class="status-led" aria-hidden="true"></span><span>{connectionLabel}</span></div>
      <span class="rail-footer-note">Local observation · 10s refresh</span>
    </div>
  </aside>

  <div class="workspace-shell">
    <header class="topbar">
      <div class="breadcrumb"><span>Snooze</span><span class="crumb-sep">/</span><strong>{pages.find((page) => page.key === active)?.label}</strong></div>
      <div class="topbar-actions">
        <div class="top-project"><span>PROJECT</span><strong>{projectName}</strong></div>
        <button class="theme-toggle kit-control-states" type="button" aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} onclick={ontoggleTheme}>
          {#if theme === "dark"}<SunIcon size={17} aria-hidden="true" />{:else}<MoonIcon size={17} aria-hidden="true" />{/if}
        </button>
        <span class="topbar-connection"><span class="status-led" aria-hidden="true"></span>{connectionLabel}</span>
      </div>
    </header>
    <main class="main-content">{@render children()}</main>
  </div>
</div>
