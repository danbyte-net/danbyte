#!/bin/sh
# Start again what the legacy bridge stopped, once the old upgrader is done.
#
#   legacy-resume.sh <app dir> <units file> <upgrader pid> <pid start time>
#
# An upgrader from before the stage (0.16.x, 0.17.0-dev1) runs this release's
# `manage.py migrate`; the bridge in core/management/commands/migrate.py stops
# timers, workers and web first, then launches this - copied out of the tree,
# as its own transient unit - because that upgrader restarts only the units
# it knows, and not at all when it fails. It waits for the upgrader's process
# to end, then starts every unit the bridge recorded. Nothing starts while
# the code on disk has migrations the database lacks.
set -u

APP="$1"
UNITS="$2"
PID="$3"
PSTART="$4"
log() { printf '%s %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
alive() {  # the same process (not a reused pid), and not a zombie
  [ -r "/proc/$PID/stat" ] || return 1
  _s=$(sed 's/^.*) //' "/proc/$PID/stat")
  [ "${_s%% *}" != Z ] && [ "$(printf '%s' "$_s" | cut -d' ' -f20)" = "$PSTART" ]
}

deadline=$(( $(date +%s) + ${DANBYTE_RESUME_WAIT:-3600} ))
while alive; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "the upgrader (pid $PID) is still running after an hour; not starting anything"
    exit 1
  fi
  sleep 5
done
log "the upgrader has finished: $(sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p' "$APP/.upgrade-status.json" 2>/dev/null)"

cd "$APP" || exit 1
if ! timeout 300 .venv/bin/python manage.py migrate --check >/dev/null 2>&1; then
  log "the code on disk has migrations the database lacks (or the database does not answer);"
  log "not starting anything - finish the upgrade, then: systemctl --user start $(tr '\n' ' ' <"$UNITS")"
  exit 1
fi
set --
while IFS= read -r u; do
  [ -n "$u" ] && set -- "$@" "$u"
done <"$UNITS"
if [ $# -gt 0 ]; then
  log "starting: $*"
  systemctl --user start "$@" || log "some units did not start"
fi
rm -f "$UNITS" "$0"
