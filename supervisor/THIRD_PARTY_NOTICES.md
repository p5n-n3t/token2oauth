# Provenance

Snooze's dashboard status separation is inspired by the Apache-2.0 OpenAI Symphony project: https://github.com/openai/symphony. No Symphony source is copied into this preview; no Elixir runtime dependency.

No AgentOps, Langfuse or Dagster code is vendored. Their module licenses must be checked before future reuse. LightSprint MCP transport follows the JSON-RPC/MCP protocol and the existing local integration's observed handshake, not a claim of official provider partnership.

## Snooze command centre UI reuse

- **kit-ui controls and interaction helpers** — Copyright 2026 Kenn Software LLC; Apache-2.0. Source: [kenn-io/kit-ui](https://github.com/kenn-io/kit-ui), pinned at `ceff715d835017daa9ec099446fa6ce71233829f`. Selected source files under `frontend/src/lib/kit/` are adapted into Snooze's Tokyo Nights theme and command-centre flows: Button, DetailDrawer, IconButton, SettingsLayout, Table, TableHeaderCell, TextInput, SearchInput, KbdBadge, SelectDropdown, StatusDot, focus-trap, overlay, popover, and floating-position helpers. Each adapted file carries its source pin and modification notice. The full Apache license is retained in `frontend/THIRD_PARTY_LICENSES-kit-ui.txt` and copied into the packaged static tree.
- **LiveQuery refresh timing** — Copyright 2026 Kenn Software LLC; MIT. Source: [kenn-io/agentsview](https://github.com/kenn-io/agentsview), pinned at `f4eacbc61119ebc2bfcaa47f141eb8103cf3edf1`, path `frontend/src/lib/utils/liveQuery.svelte.ts`. The generation-aware query timing class is adapted at `frontend/src/lib/liveQuery.svelte.ts`; it is disconnected from AgentsView stores and bound to Snooze schema-v2 polling. The complete MIT license is retained in `frontend/THIRD_PARTY_LICENSES-agentsview.txt` and copied into the packaged static tree.
- **Figtree and JetBrains Mono fonts** — WOFF2 assets copied from kit-ui at the pin above. Both are licensed under the SIL Open Font License 1.1; the complete font notice is in `frontend/OFL-fonts.txt` and copied beside the packaged font assets.
- **Lucide Svelte icons** — Copyright 2026 Lucide Icons and Contributors; ISC. The app imports selected icons from the pinned build dependency `@lucide/svelte` `1.21.0`; its complete license is retained in `frontend/THIRD_PARTY_LICENSES-lucide.txt` and copied into the packaged static tree.
- **Svelte runtime** — Copyright 2016–2025 Svelte Contributors; MIT. Svelte `5.56.3` compiles and runs the shipped component bundle. Its complete license is retained in `frontend/THIRD_PARTY_LICENSES-svelte.txt` and copied into the packaged static tree.

The Snooze logo is the existing local transparent concept asset from `docs/assets/snooze-logo-concept-v1.png`, copied into the frontend build and self-hosted with the compiled assets.
