# Snooze

![Snooze logo concept](docs/assets/snooze-logo-concept-v1.png)

[![Tests](https://github.com/p5n-n3t/snooze/actions/workflows/test.yml/badge.svg)](https://github.com/p5n-n3t/snooze/actions/workflows/test.yml)
[![Version](https://img.shields.io/badge/version-0.1.0-blue.svg)](pyproject.toml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](LICENSE)

Snooze is a local-first worker monitor and scheduler for distributed AI work. It records worker observations, keeps approved tasks under one durable owner, checks saved output against an explicit contract, and tracks incidents without using a model for routine monitoring.

The current source includes the control-plane backend and the existing worker-watch page. The refreshed command-centre UI remains in separate review. Final production-build, browser and release verification are still pending; see [implementation status](docs/IMPLEMENTATION-STATUS.md) for what has evidence today and what remains open.

## Install and open

Python 3.11 or newer is required. Clone the repository, then install it for one project with its own absolute state directory:

```bash
git clone https://github.com/p5n-n3t/snooze.git
cd snooze
bash install.sh --repo /absolute/path/to/project --state "$HOME/.local/state/snooze/project-one" --open
```

The installer creates a project-owned virtual environment and a `snooze` launcher in `~/.local/bin`. `--open` initializes the project only when that state directory does not already contain a project, then opens the local dashboard. Add `--queue /absolute/path/to/queue.json` to import a legacy queue as read-only input. Add `--service` only when you want the installer to create and start a Linux user service.

For another project, use another state directory. To open the current installation later:

```bash
snooze --state "$HOME/.local/state/snooze/project-one" open
```

With no `--state`, `snooze` opens the configured current installation. The browser connects to the localhost service; do not open the static HTML file with a `file://` URL.

## What the current implementation supports

- A Python service with SQLite-backed project, task, attempt, event and incident state, plus the existing local worker-watch page and a private API.
- LightSprint observation through a configured local MCP connection. Identity and quota remain unknown unless a provider actually reports them.
- Draft or explicitly approved task packets with stable IDs, input hashes, exact record/path scopes, dependencies and an allowlisted JSON-record output check.
- A deterministic scheduler with transactional reservations, overlapping-scope protection, policy and capacity limits, bounded recovery, and saved-artifact validation. Provider idle or a launch receipt never means a task is complete.
- A durable incident inbox, optional explicitly configured webhook or allowlisted command, and a small scoped MCP interface for compatible coordinators.
- Native history reports from Snooze events and normalized imported facts. The optional AgentsView source is a separately configured, read-only input; missing usage remains unavailable rather than zero.

Projects start as externally managed. Snooze does not take over an existing dispatcher automatically. Backend pause and emergency-stop controls govern new Snooze dispatch and recovery; they do not kill work already running at a provider.

## Guides

- [Operations](docs/OPERATIONS.md): install, state, tasks, controls, notifications, MCP and history commands.
- [Adapter support](docs/ADAPTERS.md): verified capabilities and configuration boundaries.
- [Implementation status](docs/IMPLEMENTATION-STATUS.md): proof, limits and release checks still pending.
- [Analytics details](docs/ANALYTICS.md): report fields, coverage and safe imports.
- [Roadmap](docs/ROADMAP.md): future work, kept separate from current capabilities.

## Checks and license

Run the declared Python test suite with `python3 -m unittest discover -v`. The project currently declares no separate lint or type-check command. Snooze is licensed under Apache-2.0; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
