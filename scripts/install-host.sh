#!/bin/sh
# shellcheck disable=SC3043  # `local`: dash, bash and busybox sh all have it
# The end of an install.sh run on a host that already runs Danbyte: the root
# steps (logrotate, the certificate unit and the nginx site, by
# scripts/host-sync.sh), the installer's upgrade lock, and what the
# administrator is told.
#
#   install-host.sh --app DIR --user USER --version VER [--from VER]
#                   [--wait-stage] [--lock-owner OWNER] [--host NAME]
#                   [--log-dir DIR] [--no-nginx] [--old-template FILE]
#                   [--log FILE] [--cleanup DIR]
#
# install.sh runs it from a root-only copy of the bundle's files, as the
# transient system unit danbyte-install-host.service, so a dropped SSH
# session or a bundle folder removed in the meantime skips none of it. With
# --wait-stage it waits for the service user's danbyte-upgrade.service to
# end - and, when that stopped part-way, for its recovery. Only an upgrade
# that ended done on VER gets the root steps; any other end leaves the host
# as it was. Without --wait-stage (install.sh --host-only) it runs them at
# once.
#
# The summary goes to stdout (the unit's journal) and to --log, which
# install.sh prints; <log>.rc gets the exit code: 0 upgraded (or the root
# steps alone done), 1 the upgrade failed or never ended, 2 upgraded but the
# root steps failed.
set -u

TREE=$(cd "$(dirname "$0")/.." && pwd)
# Tests put the host's files under a scratch root; empty on a real host.
R="${DANBYTE_HOST_ROOT:-}"
APP="" SVC_USER="" VERSION="" FROM="" WAIT=0 LOCK_OWNER="" HOST=""
LOG_DIR=/var/log/danbyte NGINX=1 OLD_TEMPLATE="" LOG="" CLEANUP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --from) FROM="$2"; shift 2 ;;
    --wait-stage) WAIT=1; shift ;;
    --lock-owner) LOCK_OWNER="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --no-nginx) NGINX=0; shift ;;
    --old-template) OLD_TEMPLATE="$2"; shift 2 ;;
    --log) LOG="$2"; shift 2 ;;
    --cleanup) CLEANUP="$2"; shift 2 ;;
    *) echo "install-host: unknown option $1" >&2; exit 2 ;;
  esac
done
[ -n "$APP" ] && [ -n "$SVC_USER" ] && [ -n "$VERSION" ] \
  || { echo "install-host: --app, --user and --version are required" >&2; exit 2; }
SVC_UID=$(id -u "$SVC_USER" 2>/dev/null) || { echo "install-host: no user $SVC_USER" >&2; exit 2; }
SVC_GID=$(id -g "$SVC_USER" 2>/dev/null) || SVC_GID=$SVC_UID
STATUS="$APP/.upgrade-status.json"
STAMP="$R/etc/danbyte/host-sync.json"
INSTALL_HINT="sudo ./install.sh --host-only from the bundle of $VERSION, or sudo make -C $APP host-sync"

# The summary: to the journal, and to the log install.sh prints.
say() {
  printf '%s\n' "$*"
  if [ -n "$LOG" ]; then printf '%s\n' "$*" >>"$LOG"; fi
  return 0
}
field() {  # <key>: a string field of the upgrade status, quotes and backslashes unescaped
  sed -n 's/.*"'"$1"'": *"\(\([^"\\]\|\\.\)*\)".*/\1/p' "$STATUS" 2>/dev/null | head -n 1 \
    | sed 's/\\"/"/g; s/\\\\/\\/g'
}
# As the service user without a PAM session: runuser opens one per call,
# and polling every 2 s filled the journal with session lines.
user_sc() {
  setpriv --reuid="$SVC_UID" --regid="$SVC_GID" --init-groups \
    env XDG_RUNTIME_DIR="/run/user/$SVC_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SVC_UID/bus" systemctl --user "$@"
}
recovery_pending() {
  [ -f "$(dirname "$APP")/.danbyte-upgrade/active" ] || [ -f "$APP/.danbyte-upgrade/active" ]
}
stage_warnings() {  # the stage's warnings, one per line
  sed -n 's/.*"warnings":\[\(.*\)\],"log":.*/\1/p' "$STATUS" 2>/dev/null | awk '{
    n = split($0, w, /","/)
    for (i = 1; i <= n; i++) {
      s = w[i]
      if (i == 1) sub(/^"/, "", s)
      if (i == n) sub(/"$/, "", s)
      gsub(/\\"/, "\"", s); gsub(/\\\\/, "\\", s)
      if (s != "") print s
    }
  }'
}
notes_left() {  # how many after-upgrade steps the running release still lists
  [ -x "$APP/.venv/bin/python" ] || return 0
  # shellcheck disable=SC2016  # $1 is the inner shell's
  runuser -u "$SVC_USER" -- sh -c 'cd "$1" && exec timeout 120 .venv/bin/python manage.py upgrade_notes' \
    _ "$APP" 2>/dev/null | sed -n 's/^\([0-9][0-9]*\) step(s) to do.*/\1/p' | head -n 1
}

# ── wait for the upgrade stage ──────────────────────────────────────────────
END="done"
if [ "$WAIT" = 1 ]; then
  END=""
  _until=$(( $(date +%s) + ${DANBYTE_INSTALL_HOST_WAIT:-86400} ))
  _gone=0
  _told=0
  while :; do
    case "$(field state)" in done|failed) END=$(field state); break ;; esac
    case "$(user_sc is-active danbyte-upgrade.service 2>/dev/null)" in
      inactive|failed)
        if recovery_pending; then
          [ "$_told" = 1 ] || echo "the upgrade stopped part-way; waiting for its recovery"
          _told=1
          _gone=0
        else
          # Gone before it wrote an end or a recovery marker: none will come.
          _gone=$((_gone + 1))
          [ "$_gone" -lt "${DANBYTE_INSTALL_HOST_GRACE:-10}" ] || { END=lost; break; }
        fi ;;
      *) _gone=0 ;;  # running, or the service user's manager did not answer
    esac
    [ "$(date +%s)" -lt "$_until" ] || { END=timeout; break; }
    sleep "${DANBYTE_INSTALL_HOST_POLL:-2}"
  done
  if [ "$END" = "done" ] && [ "$(field version_to | sed 's/^[vV]//')" != "${VERSION#[vV]}" ]; then
    END=other
  fi
fi

# ── the root steps, only on the release this bundle carries ─────────────────
HS_RC=0
if [ "$END" = "done" ]; then
  set -- --app "$APP" --user "$SVC_USER" --log-dir "$LOG_DIR"
  [ -z "$HOST" ] || set -- "$@" --host "$HOST"
  [ "$NGINX" = 1 ] || set -- "$@" --no-nginx
  [ -z "$OLD_TEMPLATE" ] || set -- "$@" --old-template "$OLD_TEMPLATE"
  _out=$(mktemp)
  bash "$TREE/scripts/host-sync.sh" "$@" >"$_out" 2>&1
  HS_RC=$?
  if [ "$NGINX" = 1 ]; then
    say "$(printf '\n\033[1;36m▶ %s\033[0m' "Host: logrotate, nginx + TLS, certificate unit")"
  else
    say "$(printf '\n\033[1;36m▶ %s\033[0m' "Host: logrotate")"
  fi
  while IFS= read -r _l; do say "$_l"; done <"$_out"
  rm -f "$_out"
fi

# The installer's lock, once the upgrade has ended one way or another - and
# only while it is still this run's.
if [ -n "$LOCK_OWNER" ] && [ "$END" != timeout ] && [ -f "$APP/.upgrade.lock" ]; then
  # shellcheck disable=SC2016  # $1 and $2 are the inner shell's
  runuser -u "$SVC_USER" -- flock "$APP/.upgrade.lock.guard" \
    sh -c 'grep -qF "$1" "$2" && rm -f "$2"' _ "\"owner\":\"$LOCK_OWNER\"" "$APP/.upgrade.lock" || :
fi

# ── what the administrator is told ──────────────────────────────────────────
ok() { say "$(printf '\n\033[1;32m✓ %s\033[0m' "$*")"; }
bad() { say "$(printf '\n\033[1;31m✗ %s\033[0m' "$*")"; }
warn() { say "$(printf '  \033[1;33m! %s\033[0m' "$*")"; }
RC=0
URL_HOST="${HOST%% *}"  # a site answering to two names: the first
case "$END" in
  done)
    if [ "$WAIT" = 0 ]; then
      _what="The root steps of Danbyte $VERSION are done."
    elif [ -n "$FROM" ] && [ "${FROM#[vV]}" = "${VERSION#[vV]}" ]; then
      _what="Danbyte $VERSION installed again over the same release."
    else
      _what="Danbyte upgraded ${FROM:-?} -> $VERSION."
    fi
    if [ "$HS_RC" -ne 0 ]; then
      RC=2
      bad "$_what But the root steps failed (host-sync exit $HS_RC) - run them again: $INSTALL_HINT"
    else
      ok "$_what"
    fi
    if [ "$NGINX" = 1 ]; then
      say ""
      say "  URL:  https://${URL_HOST:-<your host>}/"
    else
      say ""
      say "  URL:  http://${URL_HOST:-<your host>}:3000/  (no nginx; put your own TLS in front)"
    fi
    if [ "$WAIT" = 1 ]; then
      stage_warnings | while IFS= read -r _w; do warn "$_w"; done
    fi
    if [ "$NGINX" = 1 ] && grep -q '"certificate":"self-signed"' "$STAMP" 2>/dev/null; then
      say "  The certificate is self-signed. Settings → Updates → Site certificate gets a"
      say "  real one (Let's Encrypt in one click) or takes an uploaded pair."
    fi
    _n=$(notes_left)
    if [ -n "$_n" ] && [ "$_n" -gt 0 ]; then
      say "  After-upgrade steps left: $_n - Settings → Updates lists them."
    fi ;;
  failed)
    RC=1
    bad "The upgrade to $VERSION failed."
    _err=$(field error)
    [ -z "$_err" ] || say "  $_err"
    _log=$(field log)
    say "  log: ${_log:-$APP/.upgrade.log}"
    say "  nginx, logrotate and the certificate unit were left as they were." ;;
  lost)
    RC=1
    bad "The upgrade to $VERSION ended before it said how."
    say "  its log: sudo -u $SVC_USER XDG_RUNTIME_DIR=/run/user/$SVC_UID journalctl --user -u danbyte-upgrade"
    say "  nginx, logrotate and the certificate unit were left as they were." ;;
  other)
    RC=1
    bad "The upgrade that ended was to $(field version_to), not $VERSION."
    say "  nginx, logrotate and the certificate unit were left as they were." ;;
  timeout)
    RC=1
    say "$(printf '\n\033[1;33m! %s\033[0m' "The upgrade to $VERSION still runs after a day of waiting, so the root steps did not.")"
    say "  Once it is done: $INSTALL_HINT" ;;
esac

if [ -n "$CLEANUP" ] && [ "$CLEANUP" != / ]; then rm -rf -- "$CLEANUP"; fi
if [ -n "$LOG" ]; then
  printf '%s\n' "$RC" >"$LOG.rc.tmp" && mv -f "$LOG.rc.tmp" "$LOG.rc"
  # The newest ten runs' logs stay.
  find "$(dirname "$LOG")" -maxdepth 1 -name '*.log' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | tail -n +11 | cut -d' ' -f2- | while IFS= read -r _f; do rm -f "$_f" "$_f.rc"; done
fi
exit "$RC"
