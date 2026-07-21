#!/usr/bin/env bash
# Apply plugin changes: run database migrations, then restart the core Danbyte
# units. Launched detached (systemd-run --user) by core.services.apply_plugins
# after an operator has pip-installed a plugin and added it to PLUGINS. Runs the
# migration + restart independently of the triggering request so a long
# migration can't time it out.
set -euo pipefail

cd "${DANBYTE_DIR:?DANBYTE_DIR not set}"

# Prefer the project venv; fall back to whatever python is on PATH.
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"

"$PY" manage.py migrate --noinput

sleep "${DANBYTE_RESTART_DELAY:-1}"
for unit in "$@"; do
  systemctl --user restart "$unit" || true
done
