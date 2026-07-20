#!/bin/sh
# Danbyte upgrade from an uploaded OFFLINE BUNDLE (danbyte-<ver>-linux-x86_64.tar.gz).
# For tarball installs that have no git checkout to `git pull`. Launched DETACHED
# by the app (systemd-run --user) so it survives the restart; writes progress to
# the same status JSON the UI polls.
#
#   danbyte-upgrade-bundle.sh <path-to-bundle.tar.gz>
#
# Runs entirely as the service user (no root): deploy code, reinstall deps from
# the bundle's offline wheelhouse, migrate, collectstatic, restart user units,
# healthcheck. On failure the previous code is restored from a backup.
set -u

TARBALL="${1:?usage: danbyte-upgrade-bundle.sh <bundle.tar.gz>}"
CODE_DIR="${DANBYTE_DIR:-$HOME/danbyte}"
STATUS_FILE="${DANBYTE_UPGRADE_STATUS:-$CODE_DIR/.upgrade-status.json}"
BACKUP_DIR="${DANBYTE_BACKUP_DIR:-$CODE_DIR/../danbyte-backups}"
MAINT="${DANBYTE_MAINTENANCE_FLAG:-$CODE_DIR/.maintenance}"
PY="$CODE_DIR/.venv/bin/python"
ERR=""
TMP=""

cd "$CODE_DIR" 2>/dev/null || { echo "no code dir $CODE_DIR" >&2; exit 1; }
FROM="$("$PY" -c 'import danbyte;print(danbyte.__version__)' 2>/dev/null || echo unknown)"
VERSION="$(basename "$TARBALL" | sed -n 's/^danbyte-\(.*\)-linux.*/\1/p')"
[ -n "$VERSION" ] || VERSION="uploaded"

# Which Danbyte units this install actually has (dev vs prod).
SERVICES=""
for s in danbyte-web danbyte-backend danbyte-workers danbyte-ws danbyte-frontend-prod danbyte-docs; do
  systemctl --user cat "$s" >/dev/null 2>&1 && SERVICES="$SERVICES $s"
done
[ -n "$SERVICES" ] || SERVICES="danbyte-workers"

status() {  # <state> <step> <pct>
  esc=$(printf '%s' "$ERR" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"state":"%s","step":"%s","pct":%s,"version_to":"%s","version_from":"%s","error":"%s"}\n' \
    "$1" "$2" "$3" "$VERSION" "$FROM" "$esc" > "$STATUS_FILE.tmp"
  mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}
restart_services() { systemctl --user restart $SERVICES 2>/dev/null; }
BACKUP=""
rollback() {
  [ -n "$BACKUP" ] && [ -f "$BACKUP" ] && tar -C "$CODE_DIR" -xzf "$BACKUP" 2>/dev/null
  restart_services
}
fail() {
  ERR="$2"
  status running rollback 0
  rollback
  rm -rf "$TMP" 2>/dev/null
  rm -f "$MAINT"
  status failed "$1" 0
  exit 1
}

status running preflight 5
[ -f "$TARBALL" ] || fail preflight "bundle not found: $TARBALL"
TMP="$(mktemp -d)"
tar -xzf "$TARBALL" -C "$TMP" 2>/dev/null || fail extract "could not extract bundle (not a .tar.gz?)"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'danbyte-*' | head -1)"
[ -d "$SRC" ] || SRC="$TMP"
[ -f "$SRC/manage.py" ] || fail preflight "bundle missing manage.py — not a Danbyte release"
[ -d "$SRC/vendor/wheels" ] || fail preflight "bundle has no vendor/wheels — not an OFFLINE bundle"

status running backup 15
mkdir -p "$BACKUP_DIR"
if command -v pg_dump >/dev/null 2>&1; then
  eval "$("$PY" - <<'PYEOF' 2>/dev/null || true
import django, os
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings"); django.setup()
from django.conf import settings
d = settings.DATABASES["default"]
print(f"PGDB={d.get('NAME','')}; PGUSER={d.get('USER','')}; "
      f"PGHOST={d.get('HOST') or 'localhost'}; PGPORT={d.get('PORT') or 5432}; "
      f"export PGPASSWORD={d.get('PASSWORD','')}")
PYEOF
)"
  BACKUP_FILE="$BACKUP_DIR/db-pre-$VERSION-$(date +%s).sql.gz"
  # Don't rely on a pipe's exit status (gzip masks pg_dump's). Dump to a temp
  # file, check pg_dump succeeded AND produced a non-trivial file, THEN gzip —
  # a failed/empty backup must abort BEFORE any migration, not silently proceed.
  DUMP_TMP="$BACKUP_DIR/.db-pre-$VERSION.sql.tmp"
  DUMP_ERR="$BACKUP_DIR/.db-pre-$VERSION.err"
  # -w: never prompt for a password. Detached (no tty), a prompt would block
  # forever — the classic "stuck on Backup…". `timeout` bounds a wedged
  # connection too. Capture stderr so the real reason reaches the UI.
  [ -n "${PGPASSWORD:-}" ] || PG_NOPW="-w"
  if command -v timeout >/dev/null 2>&1; then DUMP_TIMEOUT="timeout 900"; else DUMP_TIMEOUT=""; fi
  if $DUMP_TIMEOUT pg_dump ${PG_NOPW:-} -h "${PGHOST:-localhost}" -p "${PGPORT:-5432}" \
       -U "${PGUSER:-}" "${PGDB:-}" > "$DUMP_TMP" 2>"$DUMP_ERR" \
     && [ -s "$DUMP_TMP" ]; then
    gzip -c "$DUMP_TMP" > "$BACKUP_FILE"
    rm -f "$DUMP_TMP" "$DUMP_ERR"
  else
    reason="$(tail -c 300 "$DUMP_ERR" 2>/dev/null | tr '\n' ' ')"
    rm -f "$DUMP_TMP" "$DUMP_ERR"
    [ -n "$reason" ] || reason="pg_dump errored or produced an empty dump (timed out after 900s, or auth/connection failed)"
    fail backup "db backup failed — aborting before any migration: $reason"
  fi
else
  echo "upgrade: pg_dump not found — skipping db backup" >&2
fi
# Code backup for rollback (skip the heavy, regenerable trees).
BACKUP="$BACKUP_DIR/code-pre-$VERSION-$(date +%s).tgz"
tar -C "$CODE_DIR" --exclude=./.venv --exclude=./vendor --exclude=./frontend/node_modules \
  -czf "$BACKUP" . 2>/dev/null || BACKUP=""

status running deploy 40
touch "$MAINT" 2>/dev/null || true   # nginx shows the "updating" page
# Overlay the new tree; keep .env/media (not in the bundle). Excludes the
# installer entrypoint so it doesn't clutter the code dir.
tar -C "$SRC" --exclude=./install.sh -cf - . | tar -C "$CODE_DIR" -xf - \
  || fail deploy "copying new code failed"

status running deps 60
"$CODE_DIR/vendor/python/bin/python3" -m venv "$CODE_DIR/.venv" >/dev/null 2>&1 || true
"$PY" -m pip install --no-index --find-links "$CODE_DIR/vendor/wheels" \
  -r "$CODE_DIR/requirements.txt" -q || fail deps "offline dependency install failed"

status running migrate 75
"$PY" manage.py migrate --noinput || fail migrate "database migration failed"

status running static 85
"$PY" manage.py collectstatic --noinput >/dev/null 2>&1 || true

status running restart 92
# Refresh unit symlinks so services/timers added in this release get linked +
# enabled on an in-app bundle upgrade. Best-effort.
if command -v make >/dev/null 2>&1; then
  make -C "$CODE_DIR" install-services >/dev/null 2>&1 || true
fi
restart_services

status running healthcheck 96
ok=""
i=0
while [ "$i" -lt 12 ]; do
  i=$((i + 1)); sleep 3
  # Require the real readiness endpoint (200 = Django up AND DB reachable) — a
  # 2xx/3xx from "/" would also pass on the nginx "updating" page or a login
  # redirect while the app is actually broken.
  for probe in "https://127.0.0.1/api/health/" "http://127.0.0.1:8000/api/health/"; do
    c=$(curl -ks -o /dev/null -w '%{http_code}' "$probe" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && { ok=1; break; }
  done
  [ -n "$ok" ] && break
done
[ -n "$ok" ] || fail healthcheck "app did not come back healthy after restart (/api/health/ never returned 200)"

rm -f "$MAINT" "$TARBALL"
rm -rf "$TMP"
status done done 100
echo "upgrade: now on $VERSION (from bundle)"
