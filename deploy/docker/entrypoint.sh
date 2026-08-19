#!/usr/bin/env sh
# Container entrypoint. On the backend service (MIGRATE_ON_START=1) it applies
# migrations, runs the idempotent first-run bootstrap, and collects static files
# into the shared volume nginx serves - then hands off to the given command. The
# ws / worker containers skip all that and just exec their command.
set -e

if [ "${MIGRATE_ON_START:-0}" = "1" ]; then
  echo "[entrypoint] applying migrations…"
  python manage.py migrate --noinput
  echo "[entrypoint] bootstrap (idempotent)…"
  python manage.py bootstrap
  echo "[entrypoint] collectstatic…"
  python manage.py collectstatic --noinput
fi

exec "$@"
