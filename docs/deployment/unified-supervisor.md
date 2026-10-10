# Unified Snooze supervisor package

Token2OAuth includes Snooze's Python source, static dashboard assets, and license notices in its npm package. This is packaging support for the opt-in runtime; it does not start Snooze during package installation. Node starts the Python bridge only when the operator explicitly passes `--supervisor-config` to `serve`.

## Current boundary

The runtime option is implemented as `token2oauth serve --supervisor-config /absolute/path/to/supervisor.json`. Without the option, the server does not start the Python child. The runtime resolves its embedded source from the installed package's `supervisor/` directory and invokes `python3`; Python 3.11 or newer is required. Snooze's bridge and modules use Python's standard library at runtime; no Python package installation step is needed for this source launch.

The private config format is version 1. It binds project IDs to OAuth client IDs, Token2OAuth account IDs, and registered existing sessions, and declares worker and local size limits. The current parser accepts only `gpt-6-luna`, requires `allowUnknownQuota: true`, caps work at 100 tasks / 1 MiB per job / 32 KiB per text output, and rejects symlinks, non-owner files, group/world permissions, and files over 64 KiB. Keep the file outside source control and set mode `0600` before starting the service. Do not put provider credentials in it; credentials stay in Token2OAuth's encrypted account store.

```json
{
  "version": 1,
  "projects": [{
    "projectId": "project-one",
    "clientIds": ["oauth-client-id"],
    "accountIds": ["account-id"],
    "registeredSessions": [{
      "sessionId": "existing-session-id",
      "accountId": "account-id",
      "model": "gpt-6-luna"
    }]
  }],
  "maxWorkers": 3,
  "allowUnknownQuota": true,
  "localLimits": { "maxTasks": 100, "maxJobBytes": 1048576, "maxOutputBytes": 32768 }
}
```

The private config and actual assignment/dispatch policy are being aligned with the R30 runtime work. At this revision the bridge can start, but the Node worker/fanout is deliberately not started; queued assignments do not mean provider work ran. Treat the example as a description of the current parser, not a production enablement recipe. Actual fanout and end-to-end operational verification remain pending.

## Backup and rollback planning

Before a future controlled rollout, record the exact npm artifact/version and back up the owner-only config plus the Token2OAuth config directory. The supervisor SQLite state is kept separately at `<Token2OAuth config directory>/supervisor-state/`; preserve it with the deployment record. Stop the service cleanly before copying its SQLite state so WAL contents are not missed. Keep the prior application artifact and config together; a rollback restores that artifact and config and restarts the service. To disable the optional child, restart without `--supervisor-config`; leave supervisor state intact for later investigation. No live upgrade or rollback was performed for this package verification.

## Package verification scope

The package audit checks the generated tarball's actual file list, including Python bridge/modules, nested static assets, and Snooze license notices, and checks that frontend development sources, caches, `node_modules`, and private config files are absent. Normal `npm pack` runs the existing `prepack` TypeScript build to generate `dist/`; the verification environment lacked the local TypeScript compiler, so the smoke-test tarball was created with lifecycle scripts suppressed and does not contain `dist/`. That archive is valid evidence for the Snooze payload only, not a complete Token2OAuth release artifact. The check extracts it under a temporary directory and invokes the bundled module's help/import path with `PYTHONPATH=supervisor`; it does not install the npm package or Python project, contact a provider, or run the service.
