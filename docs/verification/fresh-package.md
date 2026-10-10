# Fresh npm package smoke verification

**Run:** 2026-10-10, from the isolated `feat/t2o-package-install-harness-20261010` worktree. **Result:** passed.

The smoke harness ran `npm pack --json` with the package's normal `prepack` build, inspected both npm's pack inventory and the resulting `.tgz`, then installed that tarball into a private temporary prefix with `npm install --ignore-scripts`. The archive was **1,378,516 bytes** and contained **237 files**. The run used npm 10.9.3 (array JSON response); the harness also accepts the single-object shape used by newer npm versions, though that shape was not exercised here.

Checks passed:

- The actual archive contains the built CLI/store modules, Snooze Python bridge and jobs module, static HTML/UI assets, the package and supervisor licenses, static third-party notices, and the checked Svelte, Kit UI, Lucide, AgentsView, and font license files.
- The archive has no `node_modules`, frontend development tree, Python bytecode/cache, `.env`, supervisor config, or `.git` payload.
- The installed `token2oauth --help` command and extracted `python3 -m snooze.bridge --help` both exited successfully.
- A fresh private config directory was initialized through the installed `StateStore` API using a random admin password held only in process memory. The installed CLI served `/healthz` on a dynamically allocated loopback port and returned `ok: true`; the exact child process was stopped with SIGTERM.
- Package installation used `--ignore-scripts`; no external provider calls or system-service changes occurred. The successful run removed its private temporary directory.

The worktree had no local dependency install. For this run only, the existing locked project dependencies from the prior isolated worktree were borrowed through a temporary ignored symlink; the symlink was removed afterward. No dependency or manifest changes were made. The npm 12 object response path is implemented but was not available to verify in this environment.

Run the check after installing the repository's locked development dependencies:

```sh
node scripts/verify-package-install.mjs
```

On failure, the script stops only its own server child, redacts common token forms and the generated password, and retains a private `failure.log` under the reported temporary directory for diagnosis.
