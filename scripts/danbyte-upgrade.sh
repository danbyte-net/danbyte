#!/bin/sh
# Danbyte in-place upgrader (git install). Launched DETACHED by the app so it
# survives the service restart. Writes progress to a status JSON the UI polls.
#
#   danbyte-upgrade.sh <version-tag>
#
# Steps: preflight -> db backup -> checkout -> deps -> migrate -> frontend
# build -> restart -> healthcheck. On a failure BEFORE the migration the code
# is rolled back to where it started and services restarted. After the
# migration has run the new code stays: the old code would run against a
# schema it does not know, and the pre-upgrade backup is the way back.
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
for s in danbyte-web danbyte-backend danbyte-workers danbyte-fastlane danbyte-ws danbyte-frontend-prod; do
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
MIGRATED=""
rollback() {
  if [ -n "$MIGRATED" ]; then
    ERR="$ERR - the database is already migrated, so the new code is kept (the old code would not run on it); to go back, restore the pre-upgrade backup"
    restart_services
    return
  fi
  [ -n "$CHECKED_OUT" ] && git checkout -q "$FROM" 2>/dev/null
  restart_services
}
fail() {
  ERR="$2"
  status running rollback 0
  rollback
  rm -f "$MAINT"
  status failed "$1" 0
  exit 1
}

# A step's stderr is kept and quoted in the failure, so the status JSON says
# what actually broke (a truncated bundle, a missing wheel, the migration's
# traceback) instead of one fixed sentence per step (#185).
ERRF="$STATUS_FILE.err"
step() {  # <step> <what went wrong> <command...>
  s="$1"; what="$2"; shift 2
  "$@" 2>"$ERRF" || fail "$s" "$what: $(tail -c 300 "$ERRF" 2>/dev/null | tr -c '[:print:]' ' ')"
}

# The readiness probe must reach *this* app: on a box where Danbyte is not
# nginx's default server a bare 127.0.0.1 request lands on another server
# block, and the app port answers a nameless request with a redirect or a
# 400. So the probe carries a host the install answers to (ALLOWED_HOSTS in
# .env) and says it came over HTTPS.
HOSTS="$(sed -n 's/^ALLOWED_HOSTS=//p' "$CODE_DIR/.env" 2>/dev/null | tr -d "'\"" | tr ',' ' ')"
[ -n "$HOSTS" ] || HOSTS="127.0.0.1 localhost"
healthy() {
  for h in $HOSTS; do
    [ "$h" = "*" ] && h=127.0.0.1
    c=$(curl -ks -o /dev/null -w '%{http_code}' -H "Host: $h" -H "X-Forwarded-Proto: https" \
        "http://127.0.0.1:8000/api/health/" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && return 0
    c=$(curl -ks -o /dev/null -w '%{http_code}' --resolve "$h:443:127.0.0.1" \
        "https://$h/api/health/" 2>/dev/null || echo 000)
    [ "$c" = "200" ] && return 0
  done
  return 1
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
step preflight "git fetch failed" git fetch --tags -q origin
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
    || fail backup "pre-upgrade backup failed - aborting before any migration: $(tail -c 300 "$BACKUP_DIR/.pre-upgrade.err" 2>/dev/null | tr -c '[:print:]' ' ')"
  echo "danbyte-upgrade: backup $BACKUP_OUT" >&2
fi

status running checkout 30
touch "$MAINT" 2>/dev/null || true   # nginx shows "updating" from here
step checkout "git checkout $VERSION failed" git checkout -q "$VERSION"
CHECKED_OUT=1

status running deps 45
if [ -n "$UV" ]; then
  step deps "dependency install failed" "$UV" pip install -q --python "$PY" -r requirements.txt
elif [ -x "$CODE_DIR/.venv/bin/pip" ]; then
  step deps "dependency install failed" "$CODE_DIR/.venv/bin/pip" install -q -r requirements.txt
else
  fail deps "no uv or pip found to install dependencies"
fi

status running migrate 60
step migrate "database migration failed" "$PY" manage.py migrate --noinput
MIGRATED=1
"$PY" manage.py rebuild_search_index >/dev/null 2>&1 || true
# Private uploads are served only through Django since 0.16.12 (#227). Close
# their folders to other users, so a web server still reading media/ straight
# from disk - an nginx config rendered before this release - gets 403, not the
# file. Best effort: a folder that does not exist yet is simply skipped.
for d in documents image-attachments floor-plans oui-imports outpost-releases script-outputs; do
  [ -d "$CODE_DIR/media/$d" ] && chmod -R o-rwx "$CODE_DIR/media/$d" 2>/dev/null || true
done

status running frontend 75
step frontend "frontend build failed" \
  sh -c 'cd frontend && npm ci --no-audit --no-fund --silent && npm run build --silent'

status running restart 90
# Refresh unit symlinks so services/timers ADDED in this release (e.g. new
# background timers) get linked + enabled - otherwise an in-app upgrade silently
# never runs them. Best-effort: never fail the upgrade over it.
if command -v make >/dev/null 2>&1; then
  make -C "$CODE_DIR" install-services >/dev/null 2>&1 || true
fi
# A service ADDED in this release is linked above but never started: the
# fast lane (0.16) has to run or every sub-minute check silently falls back
# to the minute beat. Best-effort, like the linking.
systemctl --user enable --now danbyte-fastlane >/dev/null 2>&1 || true
restart_services

status running healthcheck 95
ok=""
i=0
while [ "$i" -lt 12 ]; do
  i=$((i + 1)); sleep 3
  # Require the real readiness endpoint (200 only when Django is up AND the DB
  # answers) - a 2xx/3xx from "/" would also pass on the nginx "updating" page
  # or a login redirect while the app itself is broken.
  healthy && { ok=1; break; }
done
[ -n "$ok" ] || fail healthcheck "app did not come back healthy after restart (/api/health/ never returned 200 for hosts: $HOSTS)"

rm -f "$MAINT" "$ERRF"   # healthy again - drop the "updating" page
# Surplus before-upgrade backups and other leftovers, kept to the numbers in
# Settings -> Backups. Best effort.
"$PY" manage.py housekeeping >/dev/null 2>&1 || true
status done done 100
echo "upgrade: now on $VERSION"
"$PY" manage.py upgrade_notes 2>/dev/null || true   # steps an admin still has to do
