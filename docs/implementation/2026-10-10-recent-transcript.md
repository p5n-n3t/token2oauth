# Recent transcript retrieval repair

**Assignment:** T2O-R24-20261010
**Base:** `origin/codex/unified-platform-20261010` at `cc6d6fb16e271972f5d47f3391ea57e51e4044df`
**Scope:** Transcript projection, focused tests, and this report only.

The previous transcript cap serialized the complete response and kept only its first 250,000 characters. That could discard the most recent assistant completion marker while retaining old tool output. Structured `{messages: [...]}` transcripts now produce a bounded recent-message projection that preserves role, timestamp fields, and complete supported text content. The latest assistant message is preferentially retained and addressed by `latestAssistantIndex`; `latestAssistantComplete` is true only when its content was preserved whole. Tool payload content is omitted and counted. Omitted messages/content set explicit counts, `truncated`, and `incomplete` metadata.

A single message exceeding the projection bound has its content omitted whole and is marked `complete: false`; no prefix is presented as a complete marker. Unrecognized transcript shapes receive a bounded preview with `latestAssistantComplete: false`. The existing 1 MiB MCP response-body cap remains in place and returns `response_too_large` rather than parsing a partial body. No pagination fields were added because no supported transcript pagination contract was verified.

**Executed:** mocked tests cover a long history with large old tool output and a recent assistant marker/timestamp, oversized latest assistant content, unknown legacy shape, serialized projection bound, and explicit over-limit transport error. Full `npm test` builds TypeScript and runs the repository suite. No live or paid calls were made.

**Unknown:** supplied runtime observation motivated this fix, but the live transcript endpoint and post-dispatch completion are not exercised here. Callers must check `latestAssistantComplete`; a bounded projection does not prove the remote run completed. No server wiring or transcript endpoint behavior was changed.
