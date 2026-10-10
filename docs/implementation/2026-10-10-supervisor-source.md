# Snooze supervisor source import

Imported Snooze into `supervisor/` from `p5n-n3t/snooze`, remote branch `codex/snooze-command-centre`, pinned at `1e2b56e2987e1dc201716a17805b05fbf5286623` (the requested ref suffix `1e2b56e` matched this commit). The complete Apache License 2.0 and third-party notices/security/readme files are retained. `supervisor/UPSTREAM.md` records the pin, license, archive method, and full manifest of all 174 copied tracked files. Git blob IDs were checked: all 174 copied source files match their upstream blobs; no Snooze source code was edited.

Only the named tracked roots/files were imported. The snapshot excludes `.superpowers/workertranscripts`, caches, `node_modules`, environment files, runtime state, and the standalone installer. Snooze was not installed, started, enabled, or connected to a live runtime. No Token2OAuth gateway/server/package configuration was modified.

## Verification

- Python suite: `python3 -m unittest discover -s tests` ran with isolated `HOME`, XDG directories, `SNOOZE_STATE`, and temporary directory under `/tmp`. **166/167 passed.** `test_installer.InstallerTests.test_help_and_shell_syntax` failed because it invokes root-level `install.sh`, intentionally outside the requested import list. `pytest` is not installed; the recovered suite uses `unittest`.
- Frontend dependency install: `npm ci` completed; Playwright browser download was skipped. Audit reported 0 vulnerabilities.
- Frontend tests: `npm test` passed, 12 files / 36 tests.
- Frontend type check: `npm run check` passed with 0 errors and 0 warnings.
- Frontend build: `npm run build` passed in a disposable mirror of `supervisor/`, so its asset-packaging step could not rewrite the imported snapshot. The generated entrypoint references `index-D5hMMo2o.js` and `index-Bk2cIrEJ.css`; the pinned `snooze/static/index.html` instead references `index-BKgd6QmV.js` and `index-BP2EsJEh.css`. This confirms the committed static bundle is historical relative to the current frontend source/build. It was preserved unchanged as requested.
- Whitespace check: `git diff --cached --check` reports four upstream whitespace findings: the minified historical JS asset has trailing whitespace, and three test files have a blank line at EOF (`test_artifacts.py`, `test_project_accounts.py`, `test_queueing.py`). Source blobs match the pinned commit, so these were preserved rather than edited.
- NPM package check: `npm pack --dry-run --ignore-scripts --json` listed 20 package files and **zero `supervisor/` entries**. The root package `files` allowlist does not include this directory. If publishing the imported supervisor from npm is intended, the package allowlist needs a separate change (for example `supervisor/**`); `package.json` was left untouched as required.

The browser-based E2E script was not run; no browser was installed. No paid operations or external Snooze services were used.
