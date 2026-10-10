# Third-party notices

## AgentsView chart layout and intensity helpers

Selected chart layout and bucketing ideas in this folder adapt the following MIT-licensed source files:

- `frontend/src/lib/components/analytics/Heatmap.svelte` from `kenn-io/AgentsView`, commit `f4eacbc61119ebc2bfcaa47f141eb8103cf3edf1` — weekly columns, month boundaries, and responsive cell sizing are reworked for Snooze's daily event report in `HistoryCalendarHeatmap.svelte`.
- `frontend/src/lib/components/analytics/HourOfWeekHeatmap.svelte` from the same revision — the fixed weekday/hour lookup and four-band relative intensity mapping are reworked for Snooze's local event counts in `HistoryHourHeatmap.svelte`.

These are selective adaptations, not copied components. Snooze replaces LayerChart with local CSS/SVG, uses its own DTOs, Tokyo Nights theme tokens, date labels, provenance text, accessibility labels, and report states. No upstream runtime dependency is added.

Copyright (c) 2026 Kenn Software LLC. The MIT License applies to the adapted portions:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
