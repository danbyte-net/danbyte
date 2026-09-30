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

exec 9>>"$UPG_ROOT/.recover.lock"
flock -n 9 || { echo "another recovery is running"; exit 0; }

if [ ! -f "$MARK" ]; then
  echo "no unfinished upgrade"
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
  exit 0
fi

log "recover: finishing the upgrade to $VERSION from the journal"
# From inside a boot transaction a blocking start would wait for this very
# unit (the app units are ordered after it): queue the starts instead.
NO_BLOCK=1
if j_has restore_failed; then
  # A second try at the restore, then the units the failure disabled.
  if db_restore; then
    OUT_DB=restored
    if [ -f "$STATE_DIR/disabled" ]; then
      while IFS= read -r _u; do sc enable "$_u" >/dev/null 2>&1 || :; done <"$STATE_DIR/disabled"
      rm -f "$STATE_DIR/disabled"
    fi
    run 120 "$PY" "$TOOL" maintenance-off || :
    start_recorded 1 || warn "some units did not start"
    OUTCOME=restored
    OUT_SVC=running
    ERROR="the upgrade to $VERSION failed; recovery restored the database from the snapshot and started the previous release."
    remove_recover
    finish failed
    cleanup_work
    exit 0
  fi
  log "recover: the restore failed again: $DB_DETAIL"
  exit 1
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
