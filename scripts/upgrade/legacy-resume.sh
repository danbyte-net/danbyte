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
# to end, then starts every unit the bridge recorded, the timers included.
#
# Nothing starts while the code on disk has migrations the database lacks,
# but for one case: the bridge left <units file>.db-unchanged (its migration
# was rolled back in full), the upgrade failed and the previous release's
# code is back. An old bundle upgrader's rollback extracts its archive over
# the tree and removes nothing, so this release's files stay behind - its
# migrations break the restored release's migration graph and the next
# upgrade would apply them. The files the bridge listed in <units file>.added
# are removed first; the previous code then runs on the database it ran on.
#
# Two more files from the bridge: <units file>.target, the release tag the
# upgrade was for, written into the status in place of the "uploaded" a 0.16
# bundle upgrader records (0.16's auto-upgrade retries a failed release every
# tick unless the failed status names its tag), and <units file>.report.json,
# merged into the status of a finished upgrade so it is reported like one
# the stage ran (manage.py upgrade_report --merge-legacy).
set -u

APP="$1"
UNITS="$2"
PID="$3"
PSTART="$4"
STATUS="$APP/.upgrade-status.json"
HERE=$(dirname "$0")
UNIT="danbyte-upgrade-resume-$(basename "$UNITS" .units | sed 's/^legacy-resume-//')"
log() { printf '%s %s\n' "$(date -u '+%H:%M:%S')" "$*"; }
cleanup() {
  rm -f "$UNITS" "$UNITS.db-unchanged" "$UNITS.added" "$UNITS.target" "$UNITS.report.json" "$0"
  # what a resume that never got this far left (none is waiting this long)
  find "$HERE" -maxdepth 1 -type f -name 'legacy-resume-*' -mmin +120 -exec rm -f {} + 2>/dev/null
  rmdir "$HERE" 2>/dev/null
  :
}
trap cleanup EXIT
alive() {  # the same process (not a reused pid), and not a zombie
  [ -r "/proc/$PID/stat" ] || return 1
  _s=$(sed 's/^.*) //' "/proc/$PID/stat")
  [ "${_s%% *}" != Z ] && [ "$(printf '%s' "$_s" | cut -d' ' -f20)" = "$PSTART" ]
}
ver() { sed -e 's/^[vV]//' -e 's/-dirty$//' -e 's/-[0-9][0-9]*-g[0-9a-f]*$//'; }

set --
while IFS= read -r u; do
  [ -n "$u" ] && set -- "$@" "$u"
done <"$UNITS"

edit_status() {  # note <text> | retag <tag>: the finished upgrade's status; 1: unchanged
  [ -f "$STATUS" ] || return 1
  timeout 30 .venv/bin/python -c '
import json, os, sys
path, what, text = sys.argv[1:4]
try:
    with open(path) as fh:
        st = json.load(fh)
except (OSError, ValueError):
    sys.exit(1)
if not isinstance(st, dict) or st.get("state") not in ("done", "failed"):
    sys.exit(1)
if what == "retag":
    if st.get("version_to") != "uploaded":
        sys.exit(1)
    st["version_to"] = text
else:
    warnings = st.get("warnings")
    st["warnings"] = (warnings if isinstance(warnings, list) else []) + [text]
    if st["state"] == "failed":
        st["error"] = " - ".join(x for x in (st.get("error") or "", text) if x)
with open(path + ".resume", "w") as fh:
    json.dump(st, fh)
os.replace(path + ".resume", path)
' "$STATUS" "$1" "$2" 2>/dev/null
}
note() {  # <text>: where the upgrade's outcome is read, not only in this journal
  edit_status note "$1" || :
}
refuse() {  # <why> <unit>...
  why=$1
  shift
  log "$why;"
  log "not starting anything - when that is fixed: systemctl --user start $*"
  note "nothing the upgrade stopped was started again ($# units, the timers included): $why; journalctl --user -u $UNIT has the command that starts them"
  exit 1
}

deadline=$(( $(date +%s) + ${DANBYTE_RESUME_WAIT:-3600} ))
while alive; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    log "the upgrader (pid $PID) is still running after an hour; not starting anything"
    log "when it is done: systemctl --user start $*"
    exit 1
  fi
  sleep 5
done
state=$(sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -n 1)
log "the upgrader has finished: $state"

cd "$APP" || exit 1
# An uploaded bundle the old upgrader keeps after a failure (hundreds of MB);
# one newer than the bridge's list is another upload's.
case "$state" in done|failed) finished=1 ;; *) finished="" ;; esac
if [ -n "$finished" ] && [ -f .upgrade-bundle.tar.gz ] \
    && [ ! .upgrade-bundle.tar.gz -nt "$UNITS" ]; then
  rm -f .upgrade-bundle.tar.gz && log "removed the uploaded bundle"
fi
# The release the upgrade was for, in place of "uploaded": 0.16's auto-upgrade
# then answers "failed before" for it instead of trying it again every tick.
tag=$(head -n 1 "$UNITS.target" 2>/dev/null | tr -cd 'A-Za-z0-9._+-')
if [ -n "$finished" ] && [ -n "$tag" ] && edit_status retag "$tag"; then
  log "the status names $tag, not the uploaded file"
fi

remove_added() {  # the files the failed release added, as the bridge listed them
  if [ ! -f "$UNITS.added" ]; then
    log "the bridge listed no added files; none removed"
    return 0
  fi
  top=$(pwd -P)
  n=0
  last=""
  inside=""
  while IFS= read -r f; do
    case "$f" in ''|/*) continue ;; esac
    case "/$f/" in */../*|*/./*) continue ;; esac
    d=${f%/*}
    [ "$d" = "$f" ] && d=.
    if [ "$d" != "$last" ]; then   # never through a link that leaves the tree
      last=$d
      real=$(cd "$top/$d" 2>/dev/null && pwd -P) || real=""
      case "$real/" in "$top"/*) inside=1 ;; *) inside="" ;; esac
    fi
    [ -n "$inside" ] || continue
    if [ -L "$top/$f" ] || [ -f "$top/$f" ]; then
      rm -f "$top/$f" && n=$((n + 1))
    fi
    case "$f" in *.py) b=${f##*/}; rm -f "$top/$d/__pycache__/${b%.py}".*.pyc ;; esac
  done <"$UNITS.added"
  log "removed $n file(s) the failed release had added"
}

from=$(sed -n 's/.*"version_from": *"\([^"]*\)".*/\1/p' "$STATUS" 2>/dev/null | head -n 1 | ver)
here=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' danbyte/__init__.py 2>/dev/null | head -n 1 | ver)
if [ -f "$UNITS.db-unchanged" ] && [ "$state" = failed ] && [ -n "$from" ] && [ "$here" = "$from" ]; then
  log "the upgrade failed, the database is unchanged and $from is back on disk"
  remove_added
  timeout 300 .venv/bin/python manage.py migrate --check >/dev/null 2>&1 \
    || log "migrate --check still fails on $from; starting anyway (the database is as it was)"
elif ! timeout 300 .venv/bin/python manage.py migrate --check >/dev/null 2>&1; then
  refuse "the code on disk has migrations the database lacks (or the database does not answer)" "$@"
elif [ "$state" = "done" ] && [ -f "$UNITS.report.json" ]; then
  # Before the timers start: the next auto-upgrade tick reports it.
  if out=$(timeout 120 .venv/bin/python manage.py upgrade_report --merge-legacy "$UNITS.report.json" 2>&1); then
    log "${out:-recorded the upgrade}"
  else
    log "could not record the upgrade for its report: $(printf '%s' "$out" | tail -n 1)"
  fi
fi
if [ $# -gt 0 ]; then
  # A timer that fired between the old upgrader's overlay and the bridge ran
  # this release's code on the old schema; its service stays failed otherwise.
  services=""
  for u; do
    case "$u" in *.timer) services="$services ${u%.timer}.service" ;; esac
  done
  # shellcheck disable=SC2086  # unit names, no spaces
  systemctl --user reset-failed "$@" $services 2>/dev/null || :
  log "starting: $*"
  systemctl --user start "$@" || log "some units did not start"
fi
