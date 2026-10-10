# T2O-R33 package verification

**Branch:** `feat/t2o-release-package-20261010`  
**Base:** `origin/codex/unified-platform-20261010` at `d951ea2272e2672474e3b206c9f5cf85017b1c6d`

## Package change

The npm `files` allowlist now includes `supervisor/snooze/static/**` and the Snooze upstream manifest, alongside Python modules, adapters, and existing Snooze license/security notices. This captures the nested dashboard build assets and their third-party notices while continuing to omit `supervisor/frontend` source and `node_modules`. Added an npm packlist test for required Python/static/license files and forbidden development/cache/private-config paths. Added the unified supervisor deployment note describing the explicit `serve --supervisor-config` opt-in, Python 3.11+ requirement, private config concept, backup/rollback planning, and pending worker fanout.

## Evidence

- `npm pack --dry-run --ignore-scripts --json`: passed; 116 files, 1,885,037 unpacked bytes. Required bridge/modules, dashboard JS/CSS/static files, Snooze license/notice/upstream files were present. No frontend source, `node_modules`, Python caches, `.pyc` files, or `.env` files appeared.
- `npm pack --ignore-scripts --pack-destination /tmp/t2o-r33`: produced `/tmp/t2o-r33-package/token2oauth-0.2.0.tgz`, 1,121,204 bytes compressed; the extracted archive also had 116 entries.
- Extracted package smoke test: `PYTHONPATH=<extract>/package/supervisor python3 -c 'import snooze.bridge, snooze.jobs'` passed; `python3 -m snooze.bridge --help` passed. No npm or Python package installation, provider call, or service startup was performed.
- `node --test test/packaging.test.mjs`: 1 test passed. `git diff --check`: passed.

## Limitations

A regular `npm pack --dry-run --json` invoked the existing `prepack` build and failed because this isolated worktree has no local `tsc` (`sh: 1: tsc: not found`). No dependency installation was attempted. The smoke-test archive therefore suppressed lifecycle scripts and does **not** contain generated `dist/`; it proves the packaged Snooze payload, not a complete executable Token2OAuth release archive. A release build with declared development dependencies must run the existing prepack build and repeat the archive audit.

The Node runtime currently starts the embedded bridge only with explicit configuration and has no active worker/fanout. The private config/parser is still being aligned by R30; this note describes the current implementation and does not claim operational readiness or successful job execution. No live upgrade, deployment, install lifecycle, or rollback was run.
