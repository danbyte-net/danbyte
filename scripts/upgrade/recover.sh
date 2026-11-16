#!/bin/sh
# shellcheck disable=SC3043
# Finish or roll back an upgrade whose stage died: killed, out of memory,
# stopped by a shutdown, or the host rebooted in the middle.
#
#   recover.sh            what the recovery unit and timer run
#   recover.sh --retry    also retry a database restore that failed before
#                         (danbyte-admin upgrade recover)
#
# The stage copies this file, lib.sh and dbtool.py to
# ~/.danbyte-upgrade/recover/ before it changes anything, and removes them when
# it finishes. It is the same release's code as the journal it reads.
#
# Before "resume" everything goes back (files, then the database from the
# snapshot when a migrate ran, then the units); from "resume" on users were
# writing, so the new release stays and is started. Running this twice does
# no harm: each undo looks at what is on disk.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/upgrade/lib.sh
. "$HERE/lib.sh"

RETRY=0
[ "${1:-}" = --retry ] && RETRY=1
UPG_ROOT="${DANBYTE_UPGRADE_ROOT:-$(dirname "$HERE")}"
MARK="$UPG_ROOT/active"

# A finished upgrade removed its folder: nothing to lock, nothing to do.
[ -d "$UPG_ROOT" ] || { echo "no unfinished upgrade"; exit 0; }
exec 9>>"$UPG_ROOT/.recover.lock"
flock -n 9 || { echo "another recovery is running"; exit 0; }

if [ ! -f "$MARK" ]; then
  echo "no unfinished upgrade"
  tidy_root
  exit 0
fi
WORK=$(sed -n 's/^WORK=//p' "$MARK")
_pid=$(sed -n 's/^PID=//p' "$MARK")
_start=$(sed -n 's/^START=//p' "$MARK")
if stage_alive "$_pid" "$_start"; then
  echo "the upgrade (pid $_pid) is still running"
  exit 0
fi
if [ -z "$WORK" ] || [ ! -f "$WORK/context" ]; then
  echo "the marker names no usable upgrade directory; removing it"
  rm -f "$MARK"
  tidy_root
  exit 0
fi
# shellcheck disable=SC1091
. "$WORK/context"
ctx_paths
cd "$APP" || { echo "no app directory $APP" >&2; exit 1; }
STEP=recover
ERROR=""

if j_has restore_failed; then
  if [ "$RETRY" = 0 ]; then
    log "recover: the database restore failed before - waiting for: danbyte-admin upgrade recover"
    exit 0
  fi
elif j_has finished; then
  log "recover: the upgrade had finished ($(j_get finished)); tidying up"
  remove_recover
  tidy_root
  exit 0
fi

log "recover: finishing the upgrade to $VERSION from the journal"
# From inside a boot transaction a blocking start would wait for this very
# unit (the app units are ordered after it): queue the starts instead. A
# person's retry (danbyte-admin upgrade recover) waits, and checks.
NO_BLOCK=1
[ "$RETRY" = 1 ] && NO_BLOCK=0
if j_has restore_failed; then
  # A second try at the restore, then the units the failure disabled. A
  # journal with nothing migrated has nothing to restore: an older stage
  # still ended such an upgrade in restore_failed (#278).
  if db_touched && ! j_has db_restored; then
    if ! db_restore; then
      log "recover: the restore failed again: $DB_DETAIL"
      log "recover: Danbyte stays stopped; the database is as the failed upgrade left it. Retry with: danbyte-admin upgrade recover${BACKUP_ID:+, or restore the pre-upgrade backup: danbyte-admin backup restore $BACKUP_ID --yes}"
      exit 1
    fi
  fi
  if db_touched; then OUT_DB=restored; else OUT_DB=unchanged; fi
  # The units' links first (an older stage's disable deleted them), then
  # their enablement, then the start - and only what is there counts.
  relink_units || :
  if [ -f "$STATE_DIR/disabled" ]; then
    while IFS= read -r _u; do
      unit_loaded "$_u" && sc enable "$_u" >/dev/null 2>&1 || log "recover: $_u could not be enabled"
    done <"$STATE_DIR/disabled"
  fi
  run 120 "$PY" "$TOOL" maintenance-off || :
  start_recorded "$NO_BLOCK" || warn "some units did not start"
  _gone=$(units_missing)
  _down=""
  if [ "$NO_BLOCK" = 0 ]; then
    if [ -n "$(wanted service danbyte-web danbyte-backend)" ]; then
      wait_health "${DANBYTE_UPGRADE_HEALTH_WAIT:-120}" || _down="health: $HEALTH; "
    fi
    _down="$_down$(units_down)"
  fi
  if [ -n "$_gone" ] || [ -n "$_down" ]; then
    _what="the database was not changed"
    [ "$OUT_DB" = restored ] && _what="the database was restored from the snapshot"
    ERROR="the upgrade to $VERSION failed; $_what, but the previous release is NOT running (${_gone:+missing: $_gone}${_down:+not active: $_down}). Start it by hand, $(manual_start)"
    log "recover: $ERROR"
    printf '%s\n' "$ERROR" >&2
    OUTCOME=restored
    OUT_SVC=stopped
    finish failed open
    exit 1
  fi
  rm -f "$STATE_DIR/disabled"
  if [ "$OUT_DB" = restored ]; then
    ERROR="the upgrade to $VERSION failed; recovery restored the database from the snapshot and started the previous release."
  else
    ERROR="the upgrade to $VERSION failed; the database was not changed and recovery started the previous release."
  fi
  OUTCOME=restored
  OUT_SVC=running
  remove_recover
  finish failed
  cleanup_work
  tidy_root
  exit 0
fi

if j_has resumed; then
  ERROR="the upgrade was interrupted after the new release started; recovery finished it"
  finish_forward
  exit 0
fi
ERROR="the upgrade to $VERSION was interrupted"
rollback_all
if j_has restore_failed; then exit 1; fi
exit 0
