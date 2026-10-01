#!/bin/sh
# Danbyte upgrade launcher, offline bundle (danbyte-<ver>-linux-x86_64.tar.gz).
# Started by the app (Settings -> Updates -> Upgrade from a bundle, the
# auto-upgrade timer on a bundle install, manage.py start_upgrade) as the
# transient unit danbyte-upgrade.service, as the service user - no root.
#
#   danbyte-upgrade-bundle.sh <bundle.tar.gz> [--version <tag>]
#
# This file belongs to the RUNNING release and does as little as it can:
# unpack the bundle beside the app, read which version it is (from the tree,
# never the file name), check that it is newer, built for this machine and
# carries an upgrade stage, take the pre-upgrade backup with the code that is
# running now, and exec the TARGET's scripts/upgrade/stage.sh. The target
# then upgrades itself with its own logic - see that file. With --version the
# bundle must be that release (a download that does not match its tag stops).
set -u

TARBALL="${1:?usage: danbyte-upgrade-bundle.sh <bundle.tar.gz> [--version <tag>]}"
EXPECT=""
[ "${2:-}" = --version ] && EXPECT="${3:-}"
CODE_DIR="${DANBYTE_DIR:-$HOME/danbyte}"
STATUS_FILE="${DANBYTE_UPGRADE_STATUS:-$CODE_DIR/.upgrade-status.json}"
TRIGGER="${DANBYTE_UPGRADE_TRIGGER:-manual}"
PY="$CODE_DIR/.venv/bin/python"
FROM=""
TARGET="${EXPECT:-$(basename "$TARBALL")}"
WORK=""
ERR=""

esc() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() {  # <state> <step> <pct> [retryable]
  printf '{"state":"%s","step":"%s","pct":%s,"version_to":"%s","version_from":"%s","error":"%s","stage_api":1,"kind":"bundle","trigger":"%s","attempt":%s,"retryable":%s,"started_at":%s}\n' \
    "$1" "$2" "$3" "$(esc "$TARGET")" "$(esc "$FROM")" "$(esc "$ERR")" "$(esc "$TRIGGER")" \
    "$(printf '%s' "${DANBYTE_UPGRADE_ATTEMPT:-1}" | tr -cd 0-9)" "${4:-false}" \
    "$(printf '%s' "${DANBYTE_UPGRADE_STARTED_AT:-$(date +%s)}" | tr -cd '0-9.')" >"$STATUS_FILE.tmp" \
    && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}
fail() {  # <step> <message> [retryable]
  ERR="$2 - nothing was changed; the previous release keeps running."
  [ -n "$WORK" ] && rm -rf "$WORK"
  status failed "$1" 0 "${3:-false}"
  echo "danbyte-upgrade-bundle: $2" >&2
  exit 1
}
clean() { printf '%s' "$1" | sed -e 's/^[vV]//' -e 's/-dirty$//' -e 's/-[0-9][0-9]*-g[0-9a-f]*$//'; }
vcmp() {
  "$PY" -c 'import sys
from packaging.version import Version
a, b = Version(sys.argv[1]), Version(sys.argv[2])
print((a > b) - (a < b))' "$1" "$2" 2>/dev/null && return 0
  a=$(printf '%s' "$1" | sed 's/[^0-9.].*//'); b=$(printf '%s' "$2" | sed 's/[^0-9.].*//')
  if [ "$a" = "$b" ]; then echo 0
  elif [ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | head -n 1)" = "$a" ]; then echo -1
  else echo 1; fi
}

cd "$CODE_DIR" 2>/dev/null || { echo "no code dir $CODE_DIR" >&2; exit 1; }
FROM=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' danbyte/__init__.py 2>/dev/null)
status running preflight 2

UPG_ROOT="$(dirname "$CODE_DIR")/.danbyte-upgrade"
[ "$(stat -c %d "$(dirname "$CODE_DIR")")" = "$(stat -c %d "$CODE_DIR")" ] || UPG_ROOT="$CODE_DIR/.danbyte-upgrade"
if [ -f "$UPG_ROOT/active" ]; then
  [ -f "$UPG_ROOT/recover/recover.sh" ] && sh "$UPG_ROOT/recover/recover.sh"
  [ -f "$UPG_ROOT/active" ] \
    && fail preflight "an earlier upgrade is unfinished - run: danbyte-admin upgrade recover"
  fail preflight "an interrupted upgrade was just recovered; start the upgrade again" true
fi
[ -f "$TARBALL" ] || fail preflight "bundle not found: $TARBALL"
mkdir -p "$UPG_ROOT" || fail preflight "cannot create $UPG_ROOT" true
# Unpacked, a bundle is about three times its archive.
_need=$(( $(du -k "$TARBALL" | cut -f1) * 3 ))
_avail=$(df -Pk "$UPG_ROOT" | awk 'NR==2 {print $4}')
[ "${_avail:-0}" -ge "$_need" ] \
  || fail preflight "not enough free space to unpack the bundle: $((_avail / 1024)) MB free, $((_need / 1024)) MB needed" true

WORK="$UPG_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-bundle"
mkdir -p "$WORK/extract" || fail preflight "cannot create $WORK" true
tar -xf "$TARBALL" -C "$WORK/extract" 2>"$WORK/tar.err" \
  || fail preflight "could not extract the bundle: $(tail -c 300 "$WORK/tar.err" | tr -c '[:print:]' ' ')"
TOP=$(find "$WORK/extract" -mindepth 1 -maxdepth 1 -type d -name 'danbyte-*' | head -n 1)
if [ -n "$TOP" ]; then mv "$TOP" "$WORK/src"; else mv "$WORK/extract" "$WORK/src"; fi
rm -rf "$WORK/extract"
[ -f "$WORK/src/manage.py" ] || fail preflight "the bundle has no manage.py - not a Danbyte release"
[ -d "$WORK/src/vendor/wheels" ] || fail preflight "the bundle has no vendor/wheels - not an OFFLINE bundle"
TARGET=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$WORK/src/danbyte/__init__.py" 2>/dev/null)
[ -n "$TARGET" ] || fail preflight "the bundle does not say which version it is"
if [ -n "$EXPECT" ] && [ "$(clean "$EXPECT")" != "$(clean "$TARGET")" ]; then
  fail preflight "the bundle for $EXPECT contains $TARGET"
fi
PLAT=$(sed -n 's/^platform: *//p' "$WORK/src/BUNDLE_INFO" 2>/dev/null)
if [ -n "$PLAT" ] && [ "$PLAT" != "linux-$(uname -m)" ]; then
  fail preflight "the bundle is built for $PLAT, this machine is linux-$(uname -m)"
fi
[ "$(vcmp "$TARGET" "${FROM:-0}")" -ge 0 ] || fail preflight "$TARGET is older than the running $FROM - downgrades are not supported"
API=$(tr -cd 0-9 <"$WORK/src/scripts/upgrade/STAGE_API" 2>/dev/null)
[ "${API:-0}" -ge 1 ] || fail preflight "$TARGET predates the upgrade stage"
if [ -f "$WORK/src/scripts/upgrade/MIN_FROM" ]; then
  MIN=$(tr -d ' \n' <"$WORK/src/scripts/upgrade/MIN_FROM")
  [ "$(vcmp "${FROM:-0}" "$MIN")" -ge 0 ] || fail preflight "$TARGET upgrades from $MIN or newer; upgrade to $MIN first"
fi
_named="$UPG_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$(clean "$TARGET")"
mv "$WORK" "$_named" 2>/dev/null && WORK="$_named"

# Below the stage's preflight (5): the bar never goes back at the hand-over.
status running backup 4
BACKUP="skipped"
B0=""
B1=""
if [ "${DANBYTE_SKIP_BACKUP:-0}" != 1 ] || [ "$TRIGGER" = auto ]; then
  OUTF="$WORK/backup.out"
  B0=$(date +%s)
  timeout 3600 "$PY" manage.py backup_now --kind pre_upgrade >"$OUTF" 2>&1 \
    || fail backup "pre-upgrade backup failed: $(tail -c 300 "$OUTF" | tr -c '[:print:]' ' ')" true
  B1=$(date +%s)
  BACKUP=$(grep -Eo '^[0-9a-f-]{36}' "$OUTF" | tail -n 1)
  [ -n "$BACKUP" ] || BACKUP=unknown
fi

exec env DANBYTE_DIR="$CODE_DIR" DANBYTE_UPGRADE_WORK="$WORK" DANBYTE_UPGRADE_SRC="$WORK/src" \
  DANBYTE_UPGRADE_VERSION="$(clean "$TARGET")" DANBYTE_UPGRADE_FROM="$FROM" \
  DANBYTE_UPGRADE_TARBALL="$TARBALL" DANBYTE_UPGRADE_TRIGGER="$TRIGGER" \
  DANBYTE_UPGRADE_BACKUP="$BACKUP" DANBYTE_UPGRADE_STATUS="$STATUS_FILE" \
  DANBYTE_UPGRADE_BACKUP_T0="$B0" DANBYTE_UPGRADE_BACKUP_T1="$B1" \
  /bin/sh "$WORK/src/scripts/upgrade/stage.sh" --kind bundle
