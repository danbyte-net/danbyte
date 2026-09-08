#!/bin/sh
# Danbyte in-place upgrader (git install). Launched DETACHED by the app so it
# survives the service restart. Writes progress to a status JSON the UI polls.
#
#   danbyte-upgrade.sh <version-tag>
#
# Steps: preflight -> db backup -> checkout -> deps -> migrate -> frontend
# build -> restart -> healthcheck. On failure the code is rolled back to the
# starting commit and services restarted; the DB backup is the manual net for a
# migration that already ran (post-migration rollback is never automatic).
set -u

VERSION="${1:?usage: danbyte-upgrade.sh <version>}"
CODE_DIR="${DANBYTE_DIR:-$HOME/danbyte}"
STATUS_FILE="${DANBYTE_UPGRADE_STATUS:-$CODE_DIR/.upgrade-status.json}"
BACKUP_DIR="${DANBYTE_BACKUP_DIR:-$CODE_DIR/../danbyte-backups}"
# nginx serves the "updating" page while this flag exists (see deploy/).
MAINT="${DANBYTE_MAINTENANCE_FLAG:-$CODE_DIR/.maintenance}"
PY="$CODE_DIR/.venv/bin/python"
ERR=""

cd "$CODE_DIR" 2>/dev/null || { echo "no code dir $CODE_DIR" >&2; exit 1; }
FROM="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# uv isn't always on a service's PATH - find it. Fall back to pip if present.
UV=""
for u in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "$CODE_DIR/.venv/bin/uv"; do
  [ -n "$u" ] && [ -x "$u" ] && { UV="$u"; break; }
done

# Restart whichever Danbyte units this install actually has (dev uses
# danbyte-backend; prod uses danbyte-web gunicorn + danbyte-frontend-prod SSR).
SERVICES=""
for s in danbyte-web danbyte-backend danbyte-workers danbyte-ws danbyte-frontend-prod; do
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
# Only roll back code once we've actually checked out - a preflight failure must
# not touch the tree (that orphaned dev commits when run on a working checkout).
CHECKED_OUT=""
rollback() { [ -n "$CHECKED_OUT" ] && git checkout -q "$FROM" 2>/dev/null; restart_services; }
fail() {
  ERR="$2"
  status running rollback 0
  rollback
  rm -f "$MAINT"
  status failed "$1" 0
  exit 1
}

status running preflight 5
# A bundle install has no .git - the git upgrader can't run here. The in-app
# updater must route these to the offline bundle upload path instead.
[ -d "$CODE_DIR/.git" ] \
  || fail preflight "this is a bundle install (no .git) - upgrade via the offline bundle upload, not the git updater"
# Refuse to upgrade a **development working branch** - the in-app upgrade is for
# main/tag deployments. Running it on a dev checkout does destructive git ops on
# a tree someone may be editing. Detached HEAD (a tag) and main are fine.
BR="$(git symbolic-ref --short -q HEAD || echo '(detached)')"
case "$BR" in
  main|master|'(detached)') : ;;
  *) fail preflight "refusing to upgrade the working branch '$BR' - deploy from main or a tag, not a dev checkout" ;;
esac
git fetch --tags -q origin 2>/dev/null || fail preflight "git fetch failed"
git rev-parse -q --verify "refs/tags/$VERSION^{commit}" >/dev/null 2>&1 \
  || git rev-parse -q --verify "$VERSION^{commit}" >/dev/null 2>&1 \
  || fail preflight "version '$VERSION' not found in the repo"
# Refuse if there are uncommitted local changes (we'd lose them on checkout).
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || fail preflight "the checkout has uncommitted changes; commit or stash first"

status running backup 15
mkdir -p "$BACKUP_DIR"
# The engine makes the pre-upgrade backup (database, media, config) so it is
# listed, restorable and pruned like every other backup. A missing pg_dump
# is a hard stop unless DANBYTE_SKIP_BACKUP=1 says the operator has their own.
if [ "${DANBYTE_SKIP_BACKUP:-0}" = "1" ]; then
  echo "danbyte-upgrade: DANBYTE_SKIP_BACKUP=1 - skipping the pre-upgrade backup" >&2
else
  BACKUP_OUT="$("$PY" manage.py backup_now --kind pre_upgrade 2>"$BACKUP_DIR/.pre-upgrade.err")" \
    || fail backup "pre-upgrade backup failed - aborting before any migration: $(tail -c 300 "$BACKUP_DIR/.pre-upgrade.err" 2>/dev/null | tr '\n' ' ')"
  echo "danbyte-upgrade: backup $BACKUP_OUT" >&2
fi

status running checkout 30
touch "$MAINT" 2>/dev/null || true   # nginx shows "updating" from here
git checkout -q "$VERSION" || fail checkout "git checkout $VERSION failed"
CHECKED_OUT=1

status running deps 45
if [ -n "$UV" ]; then
  "$UV" pip install -q --python "$PY" -r requirements.txt || fail deps "dependency install failed"
elif [ -x "$CODE_DIR/.venv/bin/pip" ]; then
  "$CODE_DIR/.venv/bin/pip" install -q -r requirements.txt || fail deps "dependency install failed"
else
  fail deps "no uv or pip found to install dependencies"
fi

status running migrate 60
"$PY" manage.py migrate --noinput || fail migrate "database migration failed"
"$PY" manage.py rebuild_search_index >/dev/null 2>&1 || true

status running frontend 75
( cd frontend && npm ci --no-audit --no-fund --silent && npm run build --silent ) \
  || fail frontend "frontend build failed"

status running restart 90
# Refresh unit symlinks so services/timers ADDED in this release (e.g. new
# background timers) get linked + enabled - otherwise an in-app upgrade silently
# never runs them. Best-effort: never fail the upgrade over it.
if command -v make >/dev/null 2>&1; then
  make -C "$CODE_DIR" install-services >/dev/null 2>&1 || true
fi
restart_services

status running healthcheck 95
ok=""
i=0
while [ "$i" -lt 12 ]; do
  i=$((i + 1)); sleep 3
  # Require the real readiness endpoint (200 only when Django is up AND the DB
  # answers) - a 2xx/3xx from "/" would also pass on the nginx "updating" page
  # or a login redirect while the app itself is broken.
  for probe in "https://127.0.0.1/api/health/" "http://127.0.0.1:8000/api/health/"; do
    c=$(curl -ks -o /dev/null -w '%{http_code}' "$probe" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && { ok=1; break; }
  done
  [ -n "$ok" ] && break
done
[ -n "$ok" ] || fail healthcheck "app did not come back healthy after restart (/api/health/ never returned 200)"

rm -f "$MAINT"   # healthy again - drop the "updating" page
status done done 100
echo "upgrade: now on $VERSION"
"$PY" manage.py upgrade_notes 2>/dev/null || true   # steps an admin still has to do
