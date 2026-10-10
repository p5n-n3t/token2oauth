#!/usr/bin/env bash
set -euo pipefail
snooze_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
snooze_venv="$snooze_source/.venv"
snooze_bin="$HOME/.local/bin"
snooze_repo=""; snooze_state=""; snooze_queue=""; snooze_open=0; snooze_service=0
while (($#)); do
  case "$1" in
    --help|-h)
      printf 'Snooze installer (Python 3.11+, no sudo, no Node daemon)\nUsage: bash install.sh [--repo PATH --state PATH] [--queue PATH] [--open] [--service] [--venv PATH] [--bin-dir PATH]\nExisting project history and services are never replaced. --service is opt-in.\n'
      exit 0 ;;
    --repo) snooze_repo="${2:?--repo needs a path}"; shift 2 ;;
    --state) snooze_state="${2:?--state needs a path}"; shift 2 ;;
    --queue) snooze_queue="${2:?--queue needs a path}"; shift 2 ;;
    --venv) snooze_venv="${2:?--venv needs a path}"; shift 2 ;;
    --bin-dir) snooze_bin="${2:?--bin-dir needs a path}"; shift 2 ;;
    --open) snooze_open=1; shift ;;
    --service) snooze_service=1; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
if [[ -n "$snooze_repo" && -z "$snooze_state" ]]; then
  printf 'Choose a unique --state PATH with --repo, so different repositories never share history accidentally.\n' >&2; exit 2
fi
if [[ -n "$snooze_state" && "$snooze_state" != /* ]]; then
  printf '%s\n' '--state must be an absolute path.' >&2; exit 2
fi
if [[ -e "$snooze_bin/snooze" && ! -L "$snooze_bin/snooze" ]]; then
  printf 'Refusing to replace an unrelated launcher: %s/snooze\n' "$snooze_bin" >&2; exit 2
fi
if [[ -L "$snooze_bin/snooze" ]]; then
  snooze_previous="$(readlink -- "$snooze_bin/snooze")"
  if [[ "$snooze_previous" != "$snooze_venv/bin/snooze" && "$snooze_previous" != "$snooze_source/.venv/bin/snooze" ]]; then
    printf 'Refusing to replace a different launcher target: %s\n' "$snooze_previous" >&2; exit 2
  fi
fi
python3 -c 'import sys; assert sys.version_info >= (3,11), "Python 3.11+ required"'
if [[ ! -x "$snooze_venv/bin/python" ]]; then python3 -m venv "$snooze_venv"; fi
"$snooze_venv/bin/python" -m pip install --no-deps "$snooze_source"
mkdir -p "$snooze_bin"
ln -sfn -- "$snooze_venv/bin/snooze" "$snooze_bin/snooze"
printf 'Installed: %s/snooze\n' "$snooze_bin"
snooze_args=()
if [[ -n "$snooze_state" ]]; then snooze_args=(--state "$snooze_state"); fi
if [[ -n "$snooze_repo" ]]; then
  if [[ ! -f "$snooze_state/project.json" ]]; then
    snooze_init=(init --repo "$snooze_repo")
    if [[ -n "$snooze_queue" ]]; then snooze_init+=(--queue "$snooze_queue"); fi
    "$snooze_bin/snooze" "${snooze_args[@]}" "${snooze_init[@]}"
  else
    printf 'Preserved existing project configuration: %s/project.json\n' "$snooze_state"
  fi
fi
if ((snooze_service)); then "$snooze_bin/snooze" "${snooze_args[@]}" install-service; fi
if ((snooze_open)); then "$snooze_bin/snooze" "${snooze_args[@]}" open; fi
printf 'Run: snooze --state /absolute/project-state open\n'
