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
# healthcheck. On a failure BEFORE the migration the previous code is restored
# from a backup; after the migration has run the new code stays, and the
# pre-upgrade backup is the way back.
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
for s in danbyte-web danbyte-backend danbyte-workers danbyte-fastlane danbyte-ws danbyte-frontend-prod danbyte-docs; do
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
DEPLOYED=""
MIGRATED=""
rollback() {
  if [ -n "$MIGRATED" ]; then
    ERR="$ERR - the database is already migrated, so the new code is kept (the old code would not run on it); to go back, restore the pre-upgrade backup"
    restart_services
    return
  fi
  # Only a tree the overlay has touched needs restoring, and the status must
  # say when that did not happen - a "rolled back" that left the new tree in
  # place on the old dependencies is worse than the failure itself.
  if [ -n "$DEPLOYED" ]; then
    if [ -n "$BACKUP" ] && [ -f "$BACKUP" ] && tar -C "$CODE_DIR" -xzf "$BACKUP" 2>"$ERRF"; then
      ERR="$ERR - the previous code was restored from $BACKUP"
    else
      ERR="$ERR - and the previous code could NOT be restored: $(tail -c 200 "$ERRF" 2>/dev/null | tr -c '[:print:]' ' ')"
    fi
  fi
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
[ -f "$TARBALL" ] || fail preflight "bundle not found: $TARBALL"
TMP="$(mktemp -d)"
step extract "could not extract bundle" tar -xzf "$TARBALL" -C "$TMP"
SRC="$(find "$TMP" -maxdepth 1 -type d -name 'danbyte-*' | head -1)"
[ -d "$SRC" ] || SRC="$TMP"
[ -f "$SRC/manage.py" ] || fail preflight "bundle missing manage.py - not a Danbyte release"
[ -d "$SRC/vendor/wheels" ] || fail preflight "bundle has no vendor/wheels - not an OFFLINE bundle"

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

# Code backup for rollback (skip the heavy, regenerable trees). Without it
# nothing could be put back, so a failure to write it stops the upgrade
# before the tree is touched - a full backup disk is the usual cause.
BACKUP="$BACKUP_DIR/code-pre-$VERSION-$(date +%s).tgz"
tar -C "$CODE_DIR" --exclude=./.venv --exclude=./vendor --exclude=./frontend/node_modules \
  -czf "$BACKUP" . 2>"$ERRF" \
  || { BACKUP=""; fail backup "could not write the rollback archive $BACKUP_DIR (disk full?): $(tail -c 300 "$ERRF" 2>/dev/null | tr -c '[:print:]' ' ')"; }

status running deploy 40
touch "$MAINT" 2>/dev/null || true   # nginx shows the "updating" page
DEPLOYED=1
# Overlay the new tree; keep .env/media (not in the bundle). Excludes the
# installer entrypoint so it doesn't clutter the code dir.
step deploy "copying new code failed" \
  sh -c "tar -C '$SRC' --exclude=./install.sh -cf - . | tar -C '$CODE_DIR' -xf -"

status running deps 60
"$CODE_DIR/vendor/python/bin/python3" -m venv "$CODE_DIR/.venv" >/dev/null 2>&1 || true
step deps "offline dependency install failed" \
  "$PY" -m pip install --no-index --find-links "$CODE_DIR/vendor/wheels" \
  -r "$CODE_DIR/requirements.txt" -q

status running migrate 75
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

status running static 85
"$PY" manage.py collectstatic --noinput >/dev/null 2>&1 || true

status running restart 92
# Refresh unit symlinks so services/timers added in this release get linked +
# enabled on an in-app bundle upgrade. Best-effort.
if command -v make >/dev/null 2>&1; then
  make -C "$CODE_DIR" install-services >/dev/null 2>&1 || true
fi
# A service ADDED in this release is linked above but never started: the
# fast lane (0.16) has to run or every sub-minute check silently falls back
# to the minute beat. Best-effort, like the linking.
systemctl --user enable --now danbyte-fastlane >/dev/null 2>&1 || true
restart_services

status running healthcheck 96
ok=""
i=0
while [ "$i" -lt 12 ]; do
  i=$((i + 1)); sleep 3
  # Require the real readiness endpoint (200 = Django up AND DB reachable) - a
  # 2xx/3xx from "/" would also pass on the nginx "updating" page or a login
  # redirect while the app is actually broken.
  healthy && { ok=1; break; }
done
[ -n "$ok" ] || fail healthcheck "app did not come back healthy after restart (/api/health/ never returned 200 for hosts: $HOSTS)"

rm -f "$MAINT" "$TARBALL" "$ERRF"
rm -rf "$TMP"
status done done 100
echo "upgrade: now on $VERSION (from bundle)"
"$PY" manage.py upgrade_notes 2>/dev/null || true   # steps an admin still has to do
