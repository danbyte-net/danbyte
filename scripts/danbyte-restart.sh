#!/usr/bin/env bash
# Restart the given Danbyte systemd --user units after a short delay, so the
# HTTP response that triggered the restart can flush first. Launched detached
# (systemd-run --user) by core.services.restart_services — never call directly
# from the web process, which would kill itself mid-request.
set -euo pipefail

sleep "${DANBYTE_RESTART_DELAY:-2}"

for unit in "$@"; do
  systemctl --user restart "$unit" || true
done
