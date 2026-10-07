# Lifecycle: up / down / status

`src/lifecycle.ts` is a self-contained, injectable planner and controller for
the Token2OAuth user service and its owned Tailscale path. **It is not wired
into the CLI or dashboard yet** — it is exported for later integration (see
[Integration](#integration)).

## What it manages

~~~text
https://node.example.ts.net/            (shared HTTPS :443 listener)
├── /            → http://127.0.0.1:2025   root, owned by Loopback — never touched
└── /token2oauth → http://127.0.0.1:2030   owned by Token2OAuth
~~~

- Service: `systemctl --user start|stop token2oauth.service`.
- Route: the single mount `/token2oauth` on port 443.

The only commands a plan can contain are:

~~~bash
systemctl --user start token2oauth.service
systemctl --user stop  token2oauth.service
tailscale <funnel|serve> --bg --https=443 --set-path=/token2oauth http://127.0.0.1:2030
tailscale <funnel|serve>      --https=443 --set-path=/token2oauth off
~~~

`validateStep` re-checks every step against that exact allowlist before it
runs, so an edited or deserialized plan containing anything else (`reset`, an
unscoped `off`, `--set-path=/`, anything touching `tailscaled`) is refused.

Reads used for inspection: `systemctl --user is-active|is-enabled
token2oauth.service` and `tailscale serve status --json`.

## Tailscale semantics this relies on

Verified against the Tailscale source (`cmd/tailscale/cli/serve_v2.go`,
`ipn/serve.go`) and the [serve CLI reference](https://tailscale.com/kb/1242/tailscale-serve):

1. **Scoped `off` removes one mount.** With `--set-path`, `removeWebServe`
   deletes only that mount (`RemoveWebHandler(host, port, [mount], true)`).
   Without `--set-path`, it collects *every* mount on the port and deletes them
   all — so this module always passes `--set-path`.
2. **Removing the last mount cascades.** When no handlers remain on a
   host:port, `RemoveWebHandler` deletes the `Web` entry, the `TCP` entry for
   the port and the `AllowFunnel` flag. `planDown` therefore refuses to remove
   `/token2oauth` when it is the only handler on the listener.
3. **`serve` vs `funnel` on a shared listener.** Adding a mount calls
   `applyFunnel` → `SetFunnel(host, port, allowFunnel)` for the whole
   host:port. `tailscale serve …` on a Funnel listener *clears* Funnel for
   every route on it (including root); `tailscale funnel …` on a Serve-only
   listener *enables* it. The planner always uses the subcommand that matches
   the listener's current `AllowFunnel` and blocks an explicit mode that
   would flip it. `off` itself does not change `AllowFunnel` (beyond rule 2).
4. **`reset` wipes the whole Serve config.** Never used.
5. `--bg` makes the mount persistent across reboots and `tailscale down/up`.

## Safety rules

| Situation | Result |
| --- | --- |
| `/token2oauth` (or `/token2oauth/`) maps anything other than `http://127.0.0.1:2030` | **collision** — up and down both blocked |
| Explicit `mode` would flip `AllowFunnel` on the shared listener | up blocked |
| Port 443 is a raw TCP forward | blocked |
| More than one `*:443` web listener and no `routes.host` | blocked |
| `/token2oauth` is the only handler on the listener | down's route removal blocked (use `keepRoute`) |
| Down requested from the dashboard | blocked unless `acknowledgeNoSelfRestart` or `keepService` |
| Root missing or mapping something unexpected | warning only; root is never modified |
| Other mounts / owned sub-paths present | warning; preserved |

Execution (`LifecycleController.execute`):

- **Dry-run by default.** Anything other than `{ execute: true }` returns the
  rendered commands and runs nothing.
- **Executes only the plan it is given**, in order, after `validateStep`.
- **Drift check.** Before each Tailscale write it re-reads
  `tailscale serve status --json`; if the config differs from the plan's
  snapshot it refuses and asks for a re-plan.
- **Preservation check.** After each Tailscale write it re-reads the config and
  compares `unrelatedView` (everything except the owned mount and listener
  scaffolding that exists only because of it) with the pre-write snapshot. Any
  difference stops execution before later steps (e.g. the service stop) and is
  reported. There is no automatic rollback — a human should inspect.
- It also confirms the owned mount ended up `owned` (after add) or `absent`
  (after remove).

## Pools: owned sub-paths

Future pool routes must live under `/token2oauth/`. Use `ownedSubpath(name)`
(lowercase letters, digits, dashes; max 63 chars) and
`assertWithinOwnedPath(path)`, which reject `..`, `.`, percent-encoding,
`/token2oauthx`, and root. Sub-paths are reported by inspection and are left in
place by `down` (it removes only `/token2oauth`).

## The dashboard cannot bring itself back up

The dashboard is served by the Token2OAuth process itself. Once `down` stops
`token2oauth.service`, nothing is listening to receive a later "up" click, and
a removed `/token2oauth` route is unreachable from outside anyway. So:

- A dashboard "down" must be treated as one-way. The planner blocks it unless
  the caller passes `acknowledgeNoSelfRestart: true` (or `keepService: true`
  to only detach the route).
- Restarting requires a **persistent local control plane** that is not this
  service: the CLI on the host (`systemctl --user start token2oauth.service`
  then the up plan), an SSH session, or a separate always-on supervisor (e.g.
  Loopback on :2025, or a dedicated systemd unit/socket) that holds the
  lifecycle controller. Any such control plane must itself be authenticated
  and local-only; do not expose it through the Funnel.

## Usage

~~~ts
import { LifecycleController, createExecFileRunner } from "./lifecycle.js";

const lc = new LifecycleController(createExecFileRunner());
const plan = await lc.plan("up");                    // LifecyclePlan
const preview = await lc.execute(plan);              // dry run: preview.commands
if (plan.ok && userConfirmed) await lc.execute(plan, { execute: true });

const status = await lc.status();                    // { healthy, problems, routes, service }
~~~

Tests (`test/lifecycle.test.mjs`) inject an in-memory fake for `systemctl` and
`tailscale`; no test performs real OS writes.

## Integration

Not done in this change (deliberately; the assignment owned only the new files):

1. CLI: add `token2oauth up|down|status [--execute] [--mode] [--keep-route]
   [--keep-service]` in `src/cli.ts`, printing `report.commands` on dry run.
2. Dashboard: expose `status` read-only; for down, show the one-way warning and
   pass `invokedFrom: "dashboard"`. Do not offer "up" from the dashboard.
3. `src/index.ts`: re-export `./lifecycle.js` if it should be public API.
4. Follow-up: the existing `token2oauth tailscale expose --mode serve` can
   clear `AllowFunnel` on a shared Funnel listener (rule 3); route it through
   `planUp` instead.
5. Follow-up: `uninstall.sh` runs a scoped `off` without verifying the target
   or the last-handler cascade; route it through `planDown`.
