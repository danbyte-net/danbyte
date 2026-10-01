#!/bin/sh
# shellcheck disable=SC3043
# Danbyte upgrade stage, API 1 - the TARGET release's own upgrade.
#
#   stage.sh --kind git|bundle      (from a launcher, with the environment below)
#   stage.sh --recover [--retry]    (finish or roll back an interrupted run)
#
# The installed release's launcher (scripts/danbyte-upgrade.sh,
# scripts/danbyte-upgrade-bundle.sh) or scripts/install.sh fetches or unpacks
# the target into $DANBYTE_UPGRADE_SRC, takes the pre-upgrade backup with the
# code that is running, and execs this file from that tree. So every release
# upgrades itself with its own logic, and a fix here helps the upgrade TO this
# release, not only the next one.
#
# Phases: preflight, backup, prepare (site still up), quiesce (timers,
# workers, web - nothing writes from here), swap (journaled), deps, check,
# snapshot (only with migrations pending), migrate (one transaction where
# possible), static, verify, start (behind the maintenance flag), resume
# (users back), done. A failure before resume puts everything back -
# code, venv, vendor, frontend, static, .env, unit links and, if migrate
# ran, the database - and starts what ran before. Nothing but monitoring
# data is written between quiesce and resume, so that restore loses nothing.
#
# Environment (stage API 1; a later stage keeps accepting it):
#   DANBYTE_DIR               the app directory
#   DANBYTE_UPGRADE_WORK      scratch dir on the app's filesystem
#   DANBYTE_UPGRADE_SRC       the release tree (default $WORK/src)
#   DANBYTE_UPGRADE_VERSION   target version (read from the tree when unset)
#   DANBYTE_UPGRADE_FROM      running version
#   DANBYTE_UPGRADE_SHA       git: the commit to check out
#   DANBYTE_UPGRADE_TARBALL   bundle: the upload, deleted on success
#   DANBYTE_UPGRADE_TRIGGER   button|upload|auto|admin|installer|manual
#   DANBYTE_UPGRADE_ATTEMPT   which try this is (auto-upgrade retries)
#   DANBYTE_UPGRADE_BACKUP    backup id the launcher made, or "skipped"
#   DANBYTE_UPGRADE_BACKUP_T0, _T1   when that backup started and ended (epoch s)
#   DANBYTE_SKIP_BACKUP=1     no pre-upgrade backup (ignored for auto)
#   DANBYTE_UPGRADE_STATUS    status JSON (default $DANBYTE_DIR/.upgrade-status.json)
#   DANBYTE_UPGRADE_TEST=1 + DANBYTE_UPGRADE_FAULT=<phase>   tests only
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/upgrade/lib.sh
. "$HERE/lib.sh"

case "${1:-}" in
  --recover) shift; exec /bin/sh "$HERE/recover.sh" "$@" ;;
  --kind) KIND="${2:-}" ;;
  *) echo "usage: stage.sh --kind git|bundle | --recover [--retry]" >&2; exit 2 ;;
esac
case "$KIND" in git|bundle) ;; *) echo "stage.sh: unknown kind '$KIND'" >&2; exit 2 ;; esac

APP="${DANBYTE_DIR:?DANBYTE_DIR is not set}"
WORK="${DANBYTE_UPGRADE_WORK:?DANBYTE_UPGRADE_WORK is not set}"
SRC="${DANBYTE_UPGRADE_SRC:-$WORK/src}"
UPG_ROOT="$(dirname "$WORK")"
STATUS_FILE="${DANBYTE_UPGRADE_STATUS:-$APP/.upgrade-status.json}"
TRIGGER="${DANBYTE_UPGRADE_TRIGGER:-manual}"
ATTEMPT="${DANBYTE_UPGRADE_ATTEMPT:-1}"
STARTED_AT="${DANBYTE_UPGRADE_STARTED_AT:-$(now)}"
BACKUP_ID="${DANBYTE_UPGRADE_BACKUP:-}"
TARGET_SHA="${DANBYTE_UPGRADE_SHA:-}"
TARBALL="${DANBYTE_UPGRADE_TARBALL:-}"
VERSION="${DANBYTE_UPGRADE_VERSION:-}"
[ -n "$VERSION" ] || VERSION=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$SRC/danbyte/__init__.py" 2>/dev/null)
VERSION=$(clean_ver "$VERSION")
FROM="${DANBYTE_UPGRADE_FROM:-}"
[ -n "$FROM" ] || FROM=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$APP/danbyte/__init__.py" 2>/dev/null)
ERROR=""
RETRYABLE=false
OUTCOME=""
# The stage runs Django's migrate itself; the bridge for older upgraders
# (core/management/commands/migrate.py) must never step in.
export DANBYTE_UPGRADE_STAGE=1

mkdir -p "$WORK" || { echo "cannot create $WORK" >&2; exit 1; }
ctx_paths
cd "$APP" || { echo "no app directory $APP" >&2; exit 1; }
: >>"$LOG"
log "stage API $STAGE_API: $KIND upgrade ${FROM:-?} -> ${VERSION:-?} (trigger $TRIGGER, attempt $ATTEMPT)"

# fail <message> [retryable]: record, then undo whatever the journal says.
fail() {
  ERROR="$1"
  RETRYABLE="${2:-false}"
  ERROR_TAIL=$(tail_out)
  log "FAILED in $STEP: $1"
  rollback_all
  exit 1
}

# shellcheck disable=SC2329  # the trap below calls it
on_signal() {
  trap '' INT TERM HUP
  trap - EXIT
  log "interrupted by a signal"
  if [ -n "$CHILD" ]; then
    kill -TERM "$CHILD" 2>/dev/null
    wait "$CHILD" 2>/dev/null
    CHILD=""
  fi
  j_set interrupted 1
  ERROR="the upgrade was interrupted"
  if db_touched && ! j_has resumed; then
    # Only the fast part here: files back, units stopped. The database
    # restore is left to recover.sh (the recovery unit, the timer, or the
    # next boot), never done under a stop timeout.
    stop_all || :
    rollback_files || :
    status running recover 0
    log "left for recovery: $UPG_ROOT/recover/recover.sh"
    exit 143
  fi
  rollback_all
  exit 143
}
trap on_signal INT TERM HUP
trap 'ERROR="${ERROR:-the upgrade stopped unexpectedly}"; rollback_all' EXIT

# ── 1. preflight ─────────────────────────────────────────────────────────────
step_begin preflight 5
# The stage stops every app unit. Inside one of them it would stop itself
# half way; only its own transient unit (or a login shell) is safe.
# shellcheck disable=SC2013  # unit names: one word each
for _cg in $(sed -n 's|.*/\(danbyte-[^/]*\.service\).*|\1|p' "${DANBYTE_UPGRADE_CGROUP:-/proc/self/cgroup}" 2>/dev/null); do
  case "$_cg" in
    danbyte-upgrade.service) ;;
    *) fail "the upgrade runs inside $_cg, which it has to stop - launch it with systemd-run --user" ;;
  esac
done
if [ -f "$MARK" ] && ! grep -qxF "WORK=$WORK" "$MARK"; then
  fail "an earlier upgrade is unfinished ($(sed -n 's/^WORK=//p' "$MARK")) - run: danbyte-admin upgrade recover" true
fi
for _tool in curl tar make timeout flock find sort comm; do
  command -v "$_tool" >/dev/null 2>&1 || fail "$_tool is not installed"
done
[ "$KIND" = git ] && { command -v git >/dev/null 2>&1 || fail "git is not installed"; }
[ -n "$VERSION" ] || fail "the release does not say which version it is (danbyte/__init__.py)"
# Older code on a newer schema, whoever started the stage: install.sh runs
# it without a launcher in front.
if _why=$(downgrade_refused "$VERSION" "$FROM"); then fail "$_why"; fi
[ -f "$SRC/manage.py" ] || fail "no release tree at $SRC"
[ -f "$APP/.env" ] || fail "no .env in $APP"
[ -x "$PY" ] || fail "no virtualenv at $APP/.venv"
if [ "$KIND" = git ]; then
  [ -n "$TARGET_SHA" ] || fail "no commit to check out"
  git -C "$APP" rev-parse -q --verify "$TARGET_SHA^{commit}" >/dev/null 2>&1 || fail "commit $TARGET_SHA is not in the checkout"
  [ -z "$(git -C "$APP" status --porcelain --untracked-files=no 2>/dev/null)" ] \
    || fail "the checkout has uncommitted changes; commit or stash first"
else
  [ -d "$SRC/vendor/wheels" ] || fail "the bundle has no vendor/wheels - not an offline bundle"
fi
# Leftovers of earlier runs: keep the newest one that failed, for its log.
for _old in $(find "$UPG_ROOT" -mindepth 1 -maxdepth 1 -type d ! -name recover ! -path "$WORK" 2>/dev/null \
    | LC_ALL=C sort -r | tail -n +2); do
  rm -rf "$_old"
done
[ "$(stat -c %d "$UPG_ROOT")" = "$(stat -c %d "$APP")" ] || fail "$UPG_ROOT is not on the filesystem of $APP"

# Facts only the running release can answer, with its own code and .env.
cp -p "$HERE/dbtool.py" "$WORK/dbtool.py" || fail "cannot write to $WORK"
DANBYTE_UPGRADE_MAIL="$WORK/mail.json" run 300 "$PY" "$WORK/dbtool.py" probe \
  || fail "the running release could not be inspected: $(tail_out)" true
probe() { sed -n "s/^$1=//p" "$OUT" | tail -n 1; }
P_DB_SIZE=$(probe db_size); P_DB_ROLLBACK=$(probe db_rollback); P_DB_WHY=$(probe db_rollback_why)
P_REDIS=$(probe redis); P_HELD=$(probe held); P_PLUGINS=$(probe pip_plugins); P_PYTHON=$(probe python)
[ "$P_REDIS" = 1 ] || fail "Redis does not answer: $(probe redis_error)" true
[ -z "$P_HELD" ] || fail "the site is held by something else: $P_HELD" true
j_set db_rollback "${P_DB_ROLLBACK:-0}"
if [ "$KIND" = bundle ]; then
  _newpy=$("$SRC/vendor/python/bin/python3" -c 'import sys;print("%d.%d" % sys.version_info[:2])' 2>/dev/null)
  [ -n "$_newpy" ] || fail "the bundle's Python does not run on this host"
  if [ "$_newpy" != "$P_PYTHON" ] && [ -n "$P_PLUGINS" ]; then
    fail "the release moves from Python $P_PYTHON to $_newpy and a new virtualenv would lose the pip-installed plugins ($P_PLUGINS) - reinstall them after upgrading by hand, or upload them as plugin archives"
  fi
fi
# Room for the venv copy, the snapshot and (git) the new node_modules.
_kb() { du -sk "$1" 2>/dev/null | cut -f1; }
_need=$(( $(_kb "$APP/.venv") + ${P_DB_SIZE:-0} / 1024 + 204800 ))
[ "$KIND" = git ] && _need=$(( _need + $(_kb "$APP/frontend/node_modules" || echo 0) + 0 ))
_need=$(( _need * 12 / 10 ))
_avail=$(df -Pk "$UPG_ROOT" | awk 'NR==2 {print $4}')
[ "${_avail:-0}" -ge "$_need" ] \
  || fail "not enough free space in $UPG_ROOT: $((_avail / 1024)) MB free, $((_need / 1024)) MB needed" true
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = no ]; then
  warn "linger is off for $(id -un): the services stop when the last session ends (sudo loginctl enable-linger $(id -un))"
fi
_known=" danbyte-upgrade.service danbyte-upgrade-recover.service danbyte-upgrade-recover.timer danbyte-infra.service danbyte-mockups.service "
for _u in $UNITS_WEB $UNITS_WORK; do _known="$_known$_u.service "; done
for _t in $(tree_timers "$APP") $(tree_timers "$SRC"); do _known="$_known$_t.service $_t.timer "; done
for _u in $(sc list-unit-files --no-legend 'danbyte-*' 2>/dev/null | awk '{print $1}'); do
  case "$_known" in *" $_u "*) ;; *) warn "$_u is not a Danbyte unit this upgrade knows; it is left running" ;; esac
done
if app_health; then j_set pre_health ok; else j_set pre_health down; log "before the upgrade: $HEALTH"; fi
ctx_write
{ printf 'WORK=%s\nPID=%s\nSTART=%s\n' "$WORK" "$$" "$(self_start)"; } >"$MARK.tmp" && mv -f "$MARK.tmp" "$MARK"
install_recover || fail "could not install the recovery units in $SYSTEMD_DIR"
fault preflight && fail "fault injected: preflight"
step_end ok

# ── 2. backup (the launcher normally made it with the running code) ─────────
step_begin backup 15
if [ "$BACKUP_ID" = skipped ] || { [ -z "$BACKUP_ID" ] && [ "${DANBYTE_SKIP_BACKUP:-0}" = 1 ] && [ "$TRIGGER" != auto ]; }; then
  BACKUP_ID=""
  warn "no pre-upgrade backup was taken (skipped on request)"
  step_end skipped "skipped on request"
elif [ -n "$BACKUP_ID" ]; then
  # Taken before this stage ran: the step shows when, and how long it took.
  _b0=$(printf '%s' "${DANBYTE_UPGRADE_BACKUP_T0:-}" | tr -cd 0-9)
  _b1=$(printf '%s' "${DANBYTE_UPGRADE_BACKUP_T1:-}" | tr -cd 0-9)
  if [ -n "$_b0" ] && [ -n "$_b1" ]; then STEP_T0=$_b0; STEP_T1=$_b1; fi
  step_end ok "$BACKUP_ID"
else
  run 3600 "$PY" manage.py backup_now --kind pre_upgrade \
    || fail "pre-upgrade backup failed - nothing was changed: $(tail_out)" true
  BACKUP_ID=$(grep -Eo '^[0-9a-f-]{36}' "$OUT" | tail -n 1)
  ctx_write
  step_end ok "$BACKUP_ID"
fi
fault backup && fail "fault injected: backup"

# ── 3. prepare - everything slow that needs no downtime ─────────────────────
step_begin prepare 25
if [ "$KIND" = git ]; then
  # shellcheck disable=SC2016  # $1 is the inner shell's
  run 1800 sh -c 'cd "$1" && npm ci --no-audit --no-fund' _ "$SRC/frontend" \
    || fail "npm ci failed: $(tail_out)" true
  # shellcheck disable=SC2016
  run 1800 sh -c 'cd "$1" && npm run build' _ "$SRC/frontend" \
    || fail "frontend build failed: $(tail_out)" true
  UV=""
  for _u in "$(command -v uv 2>/dev/null)" "$HOME/.local/bin/uv" "$HOME/.cargo/bin/uv" "$APP/.venv/bin/uv"; do
    [ -n "$_u" ] && [ -x "$_u" ] && { UV="$_u"; break; }
  done
  if [ -n "$UV" ]; then
    # Resolve and download into uv's cache now, into a throwaway venv, so
    # the install during the downtime needs nothing new.
    run 600 "$UV" venv -q --python "$PY" "$WORK/depcheck" \
      || fail "a scratch virtualenv could not be made: $(tail_out)" true
    run 1800 "$UV" pip install -q --python "$WORK/depcheck/bin/python" -r "$SRC/requirements.txt" \
      || fail "the new dependencies could not be resolved: $(tail_out)" true
    rm -rf "$WORK/depcheck"
  elif [ -x "$APP/.venv/bin/pip" ]; then
    run 1800 "$APP/.venv/bin/pip" download -q -d "$WORK/wheels" -r "$SRC/requirements.txt" \
      || fail "the new dependencies could not be downloaded: $(tail_out)" true
  else
    fail "no uv or pip to install the dependencies with"
  fi
else
  run 900 "$SRC/vendor/python/bin/python3" -m pip install --dry-run -q --ignore-installed --no-index \
    --find-links "$SRC/vendor/wheels" -r "$SRC/requirements.txt" \
    || fail "the bundle's wheelhouse cannot install its requirements: $(tail_out)"
fi
rm -rf "$PREV/venv.tmp"
run 1800 cp -a "$APP/.venv" "$PREV/venv.tmp" \
  || fail "could not copy the virtualenv for a rollback: $(tail_out)" true
mv "$PREV/venv.tmp" "$PREV/venv" || fail "could not keep the virtualenv copy" true
j_set venv_copy 1
fault prepare && fail "fault injected: prepare" true
step_end ok

# ── 4. quiesce - from here nothing writes but this stage ────────────────────
step_begin quiesce 35
record_units
j_set quiesced 1
stop_all || fail "the services did not stop: $(tail -n 3 "$LOG" | tr '\n' ' ')"
fault quiesce && fail "fault injected: quiesce"
step_end ok

# ── 5. swap ──────────────────────────────────────────────────────────────────
step_begin swap 45
j_set swap_started 1
cp -p "$APP/.env" "$PREV/env" || fail "could not keep a copy of .env"
j_set env_saved 1
link_snapshot "$STATE_DIR/links-before"
if [ "$KIND" = git ]; then
  j_set git_prev "$(git -C "$APP" rev-parse HEAD)"
  j_set git_branch "$(git -C "$APP" symbolic-ref --short -q HEAD || true)"
  for _d in frontend/dist frontend/node_modules staticfiles; do
    move_in "$_d" || fail "could not swap $_d"
  done
  git -C "$APP" checkout -q "$TARGET_SHA" >"$OUT" 2>&1 || fail "git checkout failed: $(tail_out)"
  j_set git_swapped 1
else
  for _d in vendor frontend/dist frontend/node_modules staticfiles; do
    move_in "$_d" || fail "could not swap $_d"
  done
  overlay_tree || fail "could not copy the new release over the old one"
fi
# Settings newer releases require, for installs from before them.
if ! grep -qE '^MONITORING_SECRET_KEY=' "$APP/.env"; then
  _sk=$(sed -n 's/^DJANGO_SECRET_KEY=//p' "$APP/.env" | tail -n 1)
  [ -n "$_sk" ] && printf '\nMONITORING_SECRET_KEY=%s\n' "$_sk" >>"$APP/.env"
fi
if ! grep -qE '^DANBYTE_LOG_DIR=' "$APP/.env" && [ -d /var/log/danbyte ] && [ -w /var/log/danbyte ]; then
  printf '\nDANBYTE_LOG_DIR=/var/log/danbyte\n' >>"$APP/.env"
fi
run 300 make -s -C "$APP" link-units || fail "the new unit files could not be linked: $(tail_out)"
link_snapshot "$STATE_DIR/links-after"
LC_ALL=C comm -13 "$STATE_DIR/links-before" "$STATE_DIR/links-after" >"$STATE_DIR/new-links"
j_set links 1
fault swap && fail "fault injected: swap"
step_end ok

# ── 6. dependencies ─────────────────────────────────────────────────────────
step_begin deps 55
j_set deps_started 1
if [ "$KIND" = git ]; then
  if [ -n "$UV" ]; then
    run 1800 "$UV" pip install -q --python "$PY" -r "$APP/requirements.txt" \
      || fail "dependency install failed: $(tail_out)"
  else
    run 1800 "$APP/.venv/bin/pip" install -q --find-links "$WORK/wheels" -r "$APP/requirements.txt" \
      || fail "dependency install failed: $(tail_out)"
  fi
else
  run 600 "$APP/vendor/python/bin/python3" -m venv "$APP/.venv" || warn "venv refresh: $(tail_out)"
  run 1800 "$PY" -m pip install -q --no-index --find-links "$APP/vendor/wheels" -r "$APP/requirements.txt" \
    || fail "offline dependency install failed: $(tail_out)"
fi
fault deps && fail "fault injected: deps"
step_end ok

# ── 7. check ─────────────────────────────────────────────────────────────────
step_begin check 60
run 600 "$PY" manage.py check || fail "manage.py check failed: $(tail_out)"
run 300 "$PY" manage.py upgrade_migrate --plan || fail "the migration plan could not be read: $(tail_out)"
PENDING=$(sed -n 's/^pending: //p' "$OUT" | tail -n 1)
PENDING=${PENDING:-0}
j_set pending "$PENDING"
fault check && fail "fault injected: check"
step_end ok "$PENDING migration(s) pending"

# ── 8. snapshot - exact, because nothing else is running ────────────────────
step_begin snapshot 65
if [ "$PENDING" -gt 0 ]; then
  if [ "$(j_get db_rollback)" != 1 ]; then
    if [ "$TRIGGER" = auto ]; then
      fail "$PENDING migration(s) to apply and the database could not be rolled back ($P_DB_WHY) - not upgrading unattended; upgrade from the Updates page"
    fi
    warn "the database cannot be rolled back if this upgrade fails: $P_DB_WHY"
    step_end skipped "no rollback possible: $P_DB_WHY"
  else
    run 3600 "$PY" "$TOOL" snapshot "$WORK/snapshot.dump" || fail "database snapshot failed: $(tail_out)"
    j_set snapshot "$WORK/snapshot.dump"
    step_end ok "$(( $(stat -c %s "$WORK/snapshot.dump") / 1048576 )) MB"
  fi
else
  step_end skipped "no migrations pending"
fi
fault snapshot && fail "fault injected: snapshot"

# ── 9. migrate ───────────────────────────────────────────────────────────────
step_begin migrate 75
j_set migrating 1
if fault migrate3; then
  j_set migrate_unchanged 1
  fail "fault injected: migrate (database unchanged)"
fi
run 7200 "$PY" manage.py upgrade_migrate
_rc=$?
case "$_rc" in
  0) j_set migrated 1 ;;
  3) j_set migrate_unchanged 1
     fail "database migration failed and was rolled back in full: $(tail_out)" ;;
  *) fail "database migration failed (exit $_rc) and may be partly applied: $(tail_out)" ;;
esac
fault migrate && fail "fault injected: migrate (after it ran)"
step_end ok "$(sed -n 's/^mode: //p' "$OUT" | tail -n 1)"

# ── 10. seeds and static files ──────────────────────────────────────────────
step_begin static 80
# New seeds (statuses, roles, catalogs) reach every install, not only the
# ones re-running install.sh. Never a superuser: an admin who deleted the
# bootstrap account does not get it back.
run 900 env DJANGO_SUPERUSER_USERNAME= DJANGO_SUPERUSER_PASSWORD= "$PY" manage.py bootstrap \
  || fail "bootstrap failed: $(tail_out)"
run 900 "$PY" manage.py collectstatic --noinput || fail "collectstatic failed: $(tail_out)"
# nginx serves static files from disk as another user. collectstatic skips
# files that did not change, so copies an earlier release wrote with the
# private media modes (0640) stay closed to it unless opened here.
if [ -d "$APP/staticfiles" ]; then
  chmod -R u=rwX,go=rX "$APP/staticfiles" 2>/dev/null \
    || warn "some static files could not be made readable for the web server"
  # nginx answers for static files while the app is down; when it runs on
  # this host, ask it for one. A 403 alone is not worth a rollback.
  if [ -f "$APP/staticfiles/admin/css/base.css" ]; then
    _h=$(app_hosts | awk '{print $1}')
    _c=$(http_code "https://$_h/static/admin/css/base.css" --resolve "$_h:443:127.0.0.1")
    [ "$_c" != 403 ] || warn "nginx answers HTTP 403 for /static/: it cannot read $APP/staticfiles (every folder above it needs o+x)"
  fi
fi
# Private uploads are served only through Django since 0.16.12 (#227).
for _d in documents image-attachments floor-plans oui-imports outpost-releases script-outputs; do
  [ -d "$APP/media/$_d" ] && chmod -R o-rwx "$APP/media/$_d" 2>/dev/null
done
run 300 "$PY" "$TOOL" release-in-flight || warn "in-flight checks were not released: $(tail_out)"
fault static && fail "fault injected: static"
step_end ok

# ── 11. verify, before anything serves ──────────────────────────────────────
step_begin verify 85
run 900 "$PY" manage.py upgrade_verify || fail "the new release does not run on this database: $(tail_out)"
fault verify && fail "fault injected: verify"
step_end ok

# ── 12. start, behind the maintenance flag ──────────────────────────────────
step_begin start 90
DANBYTE_UPGRADE_PROBE=$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')
export DANBYTE_UPGRADE_PROBE
( umask 077; printf 'X-Danbyte-Probe: %s\n' "$DANBYTE_UPGRADE_PROBE" >"$WORK/probe.hdr" )
j_set started 1
run 120 "$PY" manage.py upgrade_maintenance on --ttl 900 || fail "could not hold the site for the start: $(tail_out)"
# shellcheck disable=SC2046,SC2086
_front=$(printf '%s\n' $(wanted service $UNITS_WEB) $(new_units service) | sort -u)
_serve=""; _ui=""; _ws=""
for _u in $_front; do
  case "$_u" in
    danbyte-web.service|danbyte-backend.service) _serve="$_serve $_u" ;;
    danbyte-ws.service) _ws="$_u" ;;
    danbyte-frontend-prod.service|danbyte-frontend.service|danbyte-docs.service) _ui="$_ui $_u" ;;
  esac
done
# shellcheck disable=SC2086
start_units 0 $_serve $_ws || fail "the web units did not start"
if [ -n "$_serve" ]; then
  wait_health "${DANBYTE_UPGRADE_HEALTH_WAIT:-120}" "$VERSION" || fail "the new release did not answer healthy: $HEALTH"
  _h=$(app_hosts | awk '{print $1}')
  _c=$(http_code "http://127.0.0.1:8000/admin/login/" -H "Host: $_h" -H 'X-Forwarded-Proto: https' -H "@$WORK/probe.hdr")
  [ "$_c" = 200 ] || fail "the admin login page answered HTTP $_c"
fi
# shellcheck disable=SC2086
start_units 0 $_ui || fail "the frontend units did not start"
case "$_ui" in *frontend*)
  _until=$(( $(now) + ${DANBYTE_UPGRADE_FRONTEND_WAIT:-60} ))
  until [ "$(http_code http://127.0.0.1:3000/login)" != 000 ]; do
    [ "$(now)" -lt "$_until" ] || fail "the frontend on :3000 did not answer"
    sleep 2
  done ;;
esac
if [ -n "$_ws" ] && [ "$(http_code http://127.0.0.1:8002/)" = 000 ]; then
  warn "the websocket server on :8002 did not answer"
fi
# shellcheck disable=SC2046,SC2086
_workers=$(printf '%s\n' $(wanted service $UNITS_WORK) $(new_units service | grep -E 'danbyte-(workers|fastlane)\.service') | sort -u)
# shellcheck disable=SC2086
start_units 0 $_workers || fail "the workers did not start"
# Crash loops show up within seconds. The docs site is not worth a rollback.
# shellcheck disable=SC2046,SC2086
restart_counts $(printf '%s\n' $_workers $_serve $_ui | grep -v '^danbyte-docs\.service$') >"$STATE_DIR/restarts"
if [ -s "$STATE_DIR/restarts" ]; then
  sleep "${DANBYTE_UPGRADE_SETTLE:-15}"
  settled "$STATE_DIR/restarts" || fail "a service keeps restarting: $SETTLE_DETAIL"
fi
fault start && fail "fault injected: start"
step_end ok

# ── 13. resume - users are back; no rollback after this point ───────────────
step_begin resume 95
j_set resumed 1
run 120 "$PY" manage.py upgrade_maintenance off || warn "the maintenance flag could not be cleared; it expires by itself: $(tail_out)"
# shellcheck disable=SC2046
start_units 0 $(wanted timer) || warn "some timers did not start"
for _u in $(new_units timer) $(new_units service); do
  sc enable --now "$_u" >/dev/null 2>&1 || warn "$_u could not be enabled"
done
if prod_host; then
  for _u in $UNITS_DEV; do
    _en=$(sc is-enabled "$_u.service" 2>/dev/null)
    _ac=$(sc is-active "$_u.service" 2>/dev/null)
    if [ "$_en" = enabled ] || [ "$_ac" = active ]; then
      sc disable --now "$_u.service" >/dev/null 2>&1
      warn "$_u is a development server and was running beside danbyte-web; it is now disabled"
    fi
  done
fi
app_health "$VERSION" || warn "after the upgrade: $HEALTH"
step_end ok

# ── 14. done ─────────────────────────────────────────────────────────────────
step_begin "done" 100
trap - EXIT
trap '' INT TERM HUP
unit_loaded danbyte-search-reindex.service && sc start --no-block danbyte-search-reindex.service
run 900 "$PY" manage.py housekeeping || warn "housekeeping: $(tail_out)"
run 120 "$PY" manage.py upgrade_notes || :
if [ "$KIND" = bundle ]; then
  cp "$STATE_DIR/new.list" "$APP/.release-files" 2>/dev/null || :
  if [ -n "$TARBALL" ]; then rm -f "$TARBALL"; fi
fi
rm -f "$APP/.maintenance" "$APP/.upgrade-status.json.err"
OUTCOME=new
if [ "$(j_get pending)" -gt 0 ]; then OUT_DB=migrated; else OUT_DB=unchanged; fi
OUT_SVC=running
step_end ok
log "now on $VERSION"
remove_recover
finish "done"
rm -rf "$WORK"
rmdir "$UPG_ROOT" 2>/dev/null || :   # only when nothing else is in it
exit 0
