#!/usr/bin/env bash
set -Eeuo pipefail
PREFIX="${TOKEN2OAUTH_PREFIX:-$HOME/.local/share/token2oauth}"
PUBLIC_PATH="${TOKEN2OAUTH_PATH:-/token2oauth}"
MODE="${TOKEN2OAUTH_EXPOSE:-funnel}"
PURGE=0
REMOVE_ROUTE=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --purge) PURGE=1; shift;;
    --keep-route) REMOVE_ROUTE=0; shift;;
    --path) PUBLIC_PATH="$2"; shift 2;;
    --mode) MODE="$2"; shift 2;;
    -h|--help)
      echo "Usage: ./uninstall.sh [--purge] [--keep-route] [--path /token2oauth] [--mode funnel|serve]"
      exit 0;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

systemctl --user disable --now token2oauth.service 2>/dev/null || true
rm -f "$HOME/.config/systemd/user/token2oauth.service"
systemctl --user daemon-reload 2>/dev/null || true

if (( REMOVE_ROUTE )) && command -v tailscale >/dev/null 2>&1; then
  tailscale "$MODE" --https=443 --set-path="$PUBLIC_PATH" off 2>/dev/null ||
    sudo tailscale "$MODE" --https=443 --set-path="$PUBLIC_PATH" off 2>/dev/null || true
fi

rm -f "$HOME/.local/bin/token2oauth"
rm -rf "$PREFIX"
if (( PURGE )); then
  rm -rf "$HOME/.config/token2oauth"
  echo "Removed Token2OAuth and encrypted state."
else
  echo "Removed Token2OAuth. Encrypted state kept at ~/.config/token2oauth (use --purge to remove it)."
fi
