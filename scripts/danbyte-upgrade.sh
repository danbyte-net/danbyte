#!/bin/sh
# Danbyte upgrade launcher, git install. Started by the app (Settings ->
# Updates, the auto-upgrade timer, manage.py start_upgrade) as the transient
# unit danbyte-upgrade.service, so it outlives the restart of every service.
#
#   danbyte-upgrade.sh <version-tag>
#
# This file belongs to the RUNNING release and does as little as it can:
# fetch the tag, put the target tree beside the checkout, check that it is
# newer and carries an upgrade stage, take the pre-upgrade backup with the
# code that is running now, and exec the TARGET's scripts/upgrade/stage.sh.
# The target then upgrades itself with its own logic - see that file.
#
# It never uses its own path, so a host on an older release can run the
# target's launcher straight from git:
#   systemd-run --user --unit danbyte-upgrade sh -c \
#     'git -C ~/danbyte fetch --tags && git -C ~/danbyte show vX:scripts/danbyte-upgrade.sh | sh -s -- vX'
set -u

VERSION="${1:?usage: danbyte-upgrade.sh <version-tag>}"
CODE_DIR="${DANBYTE_DIR:-$HOME/danbyte}"
STATUS_FILE="${DANBYTE_UPGRADE_STATUS:-$CODE_DIR/.upgrade-status.json}"
TRIGGER="${DANBYTE_UPGRADE_TRIGGER:-manual}"
PY="$CODE_DIR/.venv/bin/python"
FROM=""
TARGET=""
WORK=""
ERR=""

esc() { printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
status() {  # <state> <step> <pct> [retryable]
  printf '{"state":"%s","step":"%s","pct":%s,"version_to":"%s","version_from":"%s","error":"%s","stage_api":1,"kind":"git","trigger":"%s","attempt":%s,"retryable":%s,"started_at":%s}\n' \
    "$1" "$2" "$3" "$(esc "${TARGET:-$VERSION}")" "$(esc "$FROM")" "$(esc "$ERR")" "$(esc "$TRIGGER")" \
    "$(printf '%s' "${DANBYTE_UPGRADE_ATTEMPT:-1}" | tr -cd 0-9)" "${4:-false}" \
    "$(printf '%s' "${DANBYTE_UPGRADE_STARTED_AT:-$(date +%s)}" | tr -cd '0-9.')" >"$STATUS_FILE.tmp" \
    && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}
fail() {  # <step> <message> [retryable]
  ERR="$2 - nothing was changed; the previous release keeps running."
  [ -n "$WORK" ] && rm -rf "$WORK"
  status failed "$1" 0 "${3:-false}"
  echo "danbyte-upgrade: $2" >&2
  exit 1
}
clean() { printf '%s' "$1" | sed -e 's/^[vV]//' -e 's/-dirty$//' -e 's/-[0-9][0-9]*-g[0-9a-f]*$//'; }
# -1, 0 or 1; pre-releases below their final. The numeric core alone when
# either side does not parse.
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
FROM=$(clean "$(git describe --tags --match 'v[0-9]*' 2>/dev/null)")
[ -n "$FROM" ] || FROM=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' danbyte/__init__.py 2>/dev/null)
status running preflight 2

# Scratch space beside the checkout, on its filesystem (the swap renames).
UPG_ROOT="$(dirname "$CODE_DIR")/.danbyte-upgrade"
[ "$(stat -c %d "$(dirname "$CODE_DIR")")" = "$(stat -c %d "$CODE_DIR")" ] || UPG_ROOT="$CODE_DIR/.danbyte-upgrade"
if [ -f "$UPG_ROOT/active" ]; then
  [ -f "$UPG_ROOT/recover/recover.sh" ] && sh "$UPG_ROOT/recover/recover.sh"
  [ -f "$UPG_ROOT/active" ] \
    && fail preflight "an earlier upgrade is unfinished - run: danbyte-admin upgrade recover"
  fail preflight "an interrupted upgrade was just recovered; start the upgrade again" true
fi

[ -d .git ] || fail preflight "this is a bundle install (no .git) - upgrade with the offline bundle"
BR="$(git symbolic-ref --short -q HEAD || echo '(detached)')"
case "$BR" in
  main|master|'(detached)') ;;
  *) fail preflight "refusing to upgrade the working branch '$BR' - deploy from main or a tag" ;;
esac
timeout 300 git fetch --tags -q origin 2>/dev/null || fail preflight "git fetch failed" true
SHA=$(git rev-parse -q --verify "refs/tags/$VERSION^{commit}" 2>/dev/null \
  || git rev-parse -q --verify "$VERSION^{commit}" 2>/dev/null) \
  || fail preflight "version '$VERSION' not found in the repo"
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || fail preflight "the checkout has uncommitted changes; commit or stash first"
TARGET=$(clean "$(git describe --tags --match 'v[0-9]*' "$SHA" 2>/dev/null)")
[ -n "$TARGET" ] || TARGET=$(clean "$VERSION")
[ "$(vcmp "$TARGET" "${FROM:-0}")" -ge 0 ] || fail preflight "$TARGET is older than the running $FROM - downgrades are not supported"

WORK="$UPG_ROOT/$(date -u +%Y%m%dT%H%M%SZ)-$TARGET"
mkdir -p "$WORK/src" || fail preflight "cannot create $WORK" true
git archive "$SHA" | tar -x -C "$WORK/src" || fail preflight "could not export $VERSION" true
API=$(tr -cd 0-9 <"$WORK/src/scripts/upgrade/STAGE_API" 2>/dev/null)
[ "${API:-0}" -ge 1 ] || fail preflight "$TARGET predates the upgrade stage"
if [ -f "$WORK/src/scripts/upgrade/MIN_FROM" ]; then
  MIN=$(tr -d ' \n' <"$WORK/src/scripts/upgrade/MIN_FROM")
  [ "$(vcmp "${FROM:-0}" "$MIN")" -ge 0 ] || fail preflight "$TARGET upgrades from $MIN or newer; upgrade to $MIN first"
fi

# The backup, with the code that is running (the target's stage has never
# run here; this one has). DANBYTE_SKIP_BACKUP=1 only when a person asks.
status running backup 10
BACKUP="skipped"
if [ "${DANBYTE_SKIP_BACKUP:-0}" != 1 ] || [ "$TRIGGER" = auto ]; then
  OUTF="$WORK/backup.out"
  timeout 3600 "$PY" manage.py backup_now --kind pre_upgrade >"$OUTF" 2>&1 \
    || fail backup "pre-upgrade backup failed: $(tail -c 300 "$OUTF" | tr -c '[:print:]' ' ')" true
  BACKUP=$(grep -Eo '^[0-9a-f-]{36}' "$OUTF" | tail -n 1)
  [ -n "$BACKUP" ] || BACKUP=unknown
fi

exec env DANBYTE_DIR="$CODE_DIR" DANBYTE_UPGRADE_WORK="$WORK" DANBYTE_UPGRADE_SRC="$WORK/src" \
  DANBYTE_UPGRADE_VERSION="$TARGET" DANBYTE_UPGRADE_FROM="$FROM" DANBYTE_UPGRADE_SHA="$SHA" \
  DANBYTE_UPGRADE_TRIGGER="$TRIGGER" DANBYTE_UPGRADE_BACKUP="$BACKUP" \
  DANBYTE_UPGRADE_STATUS="$STATUS_FILE" \
  /bin/sh "$WORK/src/scripts/upgrade/stage.sh" --kind git
