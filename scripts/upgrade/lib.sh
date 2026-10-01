# shellcheck shell=sh
# shellcheck disable=SC3043  # `local`: dash, bash and busybox sh all have it
#
# The upgrade stage's library: status, journal, units, the swap and its undo.
#
# Sourced by stage.sh and recover.sh of the SAME release. The stage copies
# this file, recover.sh and dbtool.py next to the journal before it touches
# anything, so a recovery always undoes a journal with the code that wrote it.
#
# The journal ($WORK/journal) is append-only key=value lines, written BEFORE
# each step that changes something (intent) and after it (done). Every undo
# looks at what is actually on disk, so running it twice, or after a kill in
# the middle of a step, puts the same state back.

STAGE_API=1
TAB="$(printf '\t')"

# App units, in stop order. Never a glob: an admin's or a plugin's own
# danbyte-* unit is left alone, and so are the upgrade's own units, the
# compose infra and the mockups.
UNITS_WORK="danbyte-workers danbyte-fastlane"
UNITS_WEB="danbyte-web danbyte-ws danbyte-backend danbyte-frontend-prod danbyte-frontend danbyte-docs"
# Dev servers a production host must never run beside danbyte-web.
UNITS_DEV="danbyte-backend danbyte-frontend"
# Long-running units a release may add: linked for the first time, they start.
UNITS_NEW_OK="danbyte-workers danbyte-fastlane danbyte-docs danbyte-web danbyte-ws danbyte-frontend-prod"

SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
CHILD=""
STEP=""
STEP_OPEN=0

now() { date +%s; }

log() {
  _msg="$(date -u '+%H:%M:%S') $*"
  printf '%s\n' "$_msg"
  if [ -n "${LOG:-}" ]; then printf '%s\n' "$_msg" >>"$LOG" 2>/dev/null || :; fi
  return 0
}

warn() {
  log "warning: $*"
  if [ -n "${WORK:-}" ] && [ -d "$WORK" ]; then
    printf '%s\n' "$(printf '%s' "$*" | tr '\n\t' '  ')" >>"$WORK/warnings"
  fi
}

# A version as the app reports it: no leading v, no describe suffix.
clean_ver() {
  printf '%s' "$1" | sed -e 's/^[vV]//' -e 's/-dirty$//' -e 's/-[0-9][0-9]*-g[0-9a-f]*$//'
}

# ver_cmp <a> <b>: -1, 0 or 1, in the order core.version.compare_versions
# gives (PEP 440): a pre-release is older than its final, so 0.17.0-dev90 <
# 0.17.0-dev91 < 0.17.0-beta.1 < 0.17.0-rc1 < 0.17.0. When either side does
# not parse (an epoch or a local part counts, as no tag has one), both compare
# on their numeric part, as the app does. Plain awk, so root runs it from a
# bundle without any Python.
ver_cmp() {
  awk -v a="$1" -v b="$2" '
    function clean(v) {   # as clean_ver
      sub(/^[vV]/, "", v); sub(/-dirty$/, "", v); sub(/-[0-9]+-g[0-9a-f]*$/, "", v)
      return v
    }
    function parse(v, K,    m, l, n) {
      v = tolower(v); sub(/^v+/, "", v)
      if (!match(v, /^[0-9]+(\.[0-9]+)*/)) return 0
      K["rel"] = substr(v, 1, RLENGTH); v = substr(v, RLENGTH + 1)
      K["pl"] = ""; K["pn"] = 0; K["post"] = -1; K["dev"] = -1
      if (match(v, /^[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?[0-9]*/)) {
        m = substr(v, 1, RLENGTH); v = substr(v, RLENGTH + 1)
        l = m; gsub(/[^a-z]/, "", l)
        n = m; sub(/^[-_.]?[a-z]+[-_.]?/, "", n)
        K["pl"] = (l == "a" || l == "alpha") ? "a" : ((l == "b" || l == "beta") ? "b" : "rc")
        K["pn"] = n + 0
      }
      if (match(v, /^-[0-9]+/)) {
        K["post"] = substr(v, 2, RLENGTH - 1) + 0; v = substr(v, RLENGTH + 1)
      } else if (match(v, /^[-_.]?(post|rev|r)[-_.]?[0-9]*/)) {
        n = substr(v, 1, RLENGTH); v = substr(v, RLENGTH + 1)
        sub(/^[-_.]?[a-z]+[-_.]?/, "", n); K["post"] = n + 0
      }
      if (match(v, /^[-_.]?dev[-_.]?[0-9]*/)) {
        n = substr(v, 1, RLENGTH); v = substr(v, RLENGTH + 1)
        sub(/^[-_.]?dev[-_.]?/, "", n); K["dev"] = n + 0
      }
      return v == ""
    }
    function sgn(p, q) { return p < q ? -1 : (p > q ? 1 : 0) }
    function release(x, y,    xa, ya, nx, ny, i, c) {
      nx = split(x, xa, "."); ny = split(y, ya, ".")
      for (i = 1; i <= nx || i <= ny; i++) {
        c = sgn(i <= nx ? xa[i] + 0 : 0, i <= ny ? ya[i] + 0 : 0)
        if (c) return c
      }
      return 0
    }
    # Before every pre-release (a bare .devN), a, b, rc, then the final.
    function phase(K) {
      if (K["pl"] == "") return (K["post"] < 0 && K["dev"] >= 0) ? 0 : 4
      return K["pl"] == "a" ? 1 : (K["pl"] == "b" ? 2 : 3)
    }
    function nodev(n) { return n < 0 ? 1e18 : n }
    function numeric(v,    p, n, i, out) {
      sub(/^[vV]+/, "", v); sub(/-.*$/, "", v)
      n = split(v, p, "."); out = ""
      for (i = 1; i <= n && p[i] ~ /^[0-9]+$/; i++) out = out (i > 1 ? "." : "") (p[i] + 0)
      return out
    }
    function tuple(x, y,    xa, ya, nx, ny, i) {
      nx = x == "" ? 0 : split(x, xa, "."); ny = y == "" ? 0 : split(y, ya, ".")
      for (i = 1; i <= nx && i <= ny; i++) if (xa[i] + 0 != ya[i] + 0) return sgn(xa[i] + 0, ya[i] + 0)
      return sgn(nx, ny)
    }
    BEGIN {
      a = clean(a); b = clean(b)
      if (!parse(a, A) || !parse(b, B)) { print tuple(numeric(a), numeric(b)); exit }
      c = release(A["rel"], B["rel"])
      if (!c) c = sgn(phase(A), phase(B))
      if (!c && A["pl"] != "") c = sgn(A["pn"], B["pn"])
      if (!c) c = sgn(A["post"], B["post"])
      if (!c) c = sgn(nodev(A["dev"]), nodev(B["dev"]))
      print c
    }'
}

# downgrade_refused <to> <from>: true, with the reason on stdout, when <to> is
# older than <from> - older code on a newer schema. Every way in asks.
downgrade_refused() {
  [ -n "$1" ] && [ -n "$2" ] || return 1
  [ "$(ver_cmp "$1" "$2")" = -1 ] || return 1
  printf 'this release is %s and the install runs %s - downgrades are not supported\n' "$1" "$2"
}

# ── context: what recover.sh needs to act on a journal ───────────────────────

CTX_KEYS="APP WORK SRC KIND VERSION FROM TRIGGER ATTEMPT STARTED_AT STATUS_FILE UPG_ROOT TARGET_SHA BACKUP_ID TARBALL"

ctx_write() {
  : >"$WORK/context.tmp"
  for _k in $CTX_KEYS; do
    eval "_v=\${$_k:-}"
    # shellcheck disable=SC2154  # _v is set by the eval above
    printf "%s='%s'\n" "$_k" "$(printf '%s' "$_v" | sed "s/'/'\\\\''/g")" >>"$WORK/context.tmp"
  done
  mv -f "$WORK/context.tmp" "$WORK/context"
}

# Paths every phase uses, from APP and WORK.
ctx_paths() {
  PREV="$WORK/prev"
  STATE_DIR="$WORK/state"
  LOG="$WORK/upgrade.log"
  OUT="$WORK/step.out"
  PY="$APP/.venv/bin/python"
  TOOL="$UPG_ROOT/recover/dbtool.py"
  MARK="$UPG_ROOT/active"
  mkdir -p "$PREV" "$STATE_DIR"
}

# ── journal ──────────────────────────────────────────────────────────────────

j_set() {
  printf '%s=%s\n' "$1" "$2" >>"$WORK/journal"
  sync "$WORK/journal" 2>/dev/null || :
}
j_get() { sed -n "s/^$1=//p" "$WORK/journal" 2>/dev/null | tail -n 1; }
j_has() { grep -q "^$1=" "$WORK/journal" 2>/dev/null; }
j_list() { sed -n "s/^$1=//p" "$WORK/journal" 2>/dev/null; }

# The database may differ from the snapshot: a migrate ran (or was running).
db_touched() { j_has migrating && ! j_has migrate_unchanged; }

# ── status JSON (read by core.upgrade and every UI that polls it) ────────────

json_s() {
  printf '%s' "$1" | tr '\n\r\t' '   ' | tr -d '\000-\010\013\014\016-\037\177' \
    | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

json_lines() {  # <file> -> JSON array of its non-empty lines
  _first=1
  printf '['
  if [ -f "$1" ]; then
    while IFS= read -r _line || [ -n "$_line" ]; do
      [ -n "$_line" ] || continue
      [ "$_first" = 1 ] || printf ','
      _first=0
      printf '"%s"' "$(json_s "$_line")"
    done <"$1"
  fi
  printf ']'
}

steps_json() {
  _first=1
  printf '['
  if [ -f "$WORK/steps" ]; then
    while IFS="$TAB" read -r _n _s _a _e _d; do
      [ -n "$_n" ] || continue
      [ "$_first" = 1 ] || printf ','
      _first=0
      printf '{"name":"%s","status":"%s","started":%s,"ended":%s,"detail":"%s"}' \
        "$_n" "$_s" "${_a:-null}" "${_e:-null}" "$(json_s "${_d:-}")"
    done <"$WORK/steps"
  fi
  if [ "$STEP_OPEN" = 1 ]; then
    [ "$_first" = 1 ] || printf ','
    printf '{"name":"%s","status":"running","started":%s,"ended":null,"detail":""}' \
      "$STEP" "${STEP_T0:-null}"
  fi
  printf ']'
}

# status <running|done|failed> <step> <pct>. `state` stays one of those
# three for every UI that ever polled it; the rest is new in stage API 1.
status() {
  [ -n "${STATUS_FILE:-}" ] || return 0
  _outcome=null
  if [ -n "${OUTCOME:-}" ]; then
    _outcome=$(printf '{"code":"%s","database":"%s","services":"%s","backup":"%s"}' \
      "$OUTCOME" "${OUT_DB:-unchanged}" "${OUT_SVC:-running}" "$(json_s "${BACKUP_ID:-}")")
  fi
  _att=$(printf '%s' "${ATTEMPT:-1}" | tr -cd '0-9')
  _t0=$(printf '%s' "${STARTED_AT:-}" | tr -cd '0-9.')
  {
    printf '{"state":"%s","step":"%s","pct":%s' "$1" "$(json_s "$2")" "$3"
    printf ',"version_to":"%s","version_from":"%s"' "$(json_s "${VERSION:-}")" "$(json_s "${FROM:-}")"
    printf ',"error":"%s","error_tail":"%s"' "$(json_s "${ERROR:-}")" "$(json_s "${ERROR_TAIL:-}")"
    printf ',"stage_api":%s,"kind":"%s","trigger":"%s","attempt":%s' \
      "$STAGE_API" "$(json_s "${KIND:-}")" "$(json_s "${TRIGGER:-}")" "${_att:-1}"
    printf ',"started_at":%s,"finished_at":%s' "${_t0:-null}" "${FINISHED_AT:-null}"
    printf ',"retryable":%s,"outcome":%s' "${RETRYABLE:-false}" "$_outcome"
    printf ',"steps":'
    steps_json
    printf ',"warnings":'
    json_lines "$WORK/warnings"
    printf ',"log":"%s"}\n' "$(json_s "${LOG_FINAL:-${LOG:-}}")"
  } >"$STATUS_FILE.tmp" && mv -f "$STATUS_FILE.tmp" "$STATUS_FILE"
}

step_begin() {  # <name> <pct>
  STEP="$1"
  STEP_T0=$(now)
  STEP_OPEN=1
  log "== $1"
  status running "$1" "$2"
}

step_end() {  # <ok|failed|skipped> [detail]; STEP_T1 set: when it ended
  [ "$STEP_OPEN" = 1 ] || return 0
  STEP_OPEN=0
  printf '%s\t%s\t%s\t%s\t%s\n' "$STEP" "$1" "$STEP_T0" "${STEP_T1:-$(now)}" \
    "$(printf '%s' "${2:-}" | tr '\t\n\r' '   ' | cut -c1-400)" >>"$WORK/steps"
  STEP_T1=""
}

# ── running commands ─────────────────────────────────────────────────────────

# run <timeout-seconds> <command...>: output kept in $OUT (quoted when the
# step fails) and the log. In the background and waited for, so a TERM
# reaches the stage's trap at once instead of after the command.
run() {
  _to="$1"
  shift
  log "+ $*"
  timeout --kill-after=30 "$_to" "$@" >"$OUT" 2>&1 </dev/null &
  CHILD=$!
  wait "$CHILD"
  _rc=$?
  CHILD=""
  cat "$OUT" >>"$LOG" 2>/dev/null || :
  if [ "$_rc" -eq 124 ]; then printf 'timed out after %ss\n' "$_to" | tee -a "$OUT" >>"$LOG"; fi
  return "$_rc"
}

tail_out() {
  tail -c 600 "$OUT" 2>/dev/null | tr -c '[:print:]' ' ' | tr -s ' '
}

# Fault injection for the upgrade tests: honoured only with both variables.
fault() {  # <phase>
  [ "${DANBYTE_UPGRADE_TEST:-}" = 1 ] && [ "${DANBYTE_UPGRADE_FAULT:-}" = "$1" ]
}

# ── units ────────────────────────────────────────────────────────────────────

sc() { systemctl --user "$@"; }

unit_loaded() {
  [ "$(sc show -p LoadState --value "$1" 2>/dev/null)" = loaded ]
}

# The timers a tree's Makefile installs.
tree_timers() {  # <tree>
  sed -n 's/^TIMERS[[:space:]]*:=[[:space:]]*//p' "$1/Makefile" 2>/dev/null | head -n 1
}

# Record every app unit that is loaded: "unit enabled-state active-state".
record_units() {
  : >"$STATE_DIR/units"
  for _u in $UNITS_WEB $UNITS_WORK; do
    _u="$_u.service"
    unit_loaded "$_u" || continue
    printf '%s %s %s\n' "$_u" "$(sc is-enabled "$_u" 2>/dev/null | head -n 1)" \
      "$(sc is-active "$_u" 2>/dev/null | head -n 1)" >>"$STATE_DIR/units"
  done
  for _t in $(tree_timers "$APP"); do
    _t="$_t.timer"
    unit_loaded "$_t" || continue
    printf '%s %s %s\n' "$_t" "$(sc is-enabled "$_t" 2>/dev/null | head -n 1)" \
      "$(sc is-active "$_t" 2>/dev/null | head -n 1)" >>"$STATE_DIR/units"
  done
}

# A production host: the gunicorn unit is what runs at boot.
prod_host() {
  grep -q '^danbyte-web.service enabled' "$STATE_DIR/units" 2>/dev/null
}

# What ran before the upgrade and runs again after it: units that were
# enabled or active. An admin-disabled timer stays off; a crash-looping
# but enabled web unit is still started; a stray dev server on a
# production host is not.
wanted() {  # <service|timer> [group units...]
  _kind="$1"
  shift
  [ -f "$STATE_DIR/units" ] || return 0
  while read -r _u _en _ac; do
    case "$_u" in *."$_kind") ;; *) continue ;; esac
    if [ $# -gt 0 ]; then
      _in=0
      for _g in "$@"; do [ "$_u" = "$_g.service" ] && _in=1; done
      [ "$_in" = 1 ] || continue
    fi
    case "$_en" in enabled|enabled-runtime) ;; *)
      case "$_ac" in active|activating|reloading|deactivating) ;; *) continue ;; esac ;;
    esac
    if prod_host; then
      case " $UNITS_DEV " in *" ${_u%.service} "*) continue ;; esac
    fi
    printf '%s\n' "$_u"
  done <"$STATE_DIR/units"
}

# Units a release linked for the first time that should run.
new_units() {  # <service|timer>
  [ -f "$STATE_DIR/new-links" ] || return 0
  while read -r _l; do
    case "$_l" in
      *.timer) [ "$1" = timer ] && printf '%s\n' "$_l" ;;
      *.service)
        [ "$1" = service ] || continue
        case " $UNITS_NEW_OK " in *" ${_l%.service} "*) ;; *) continue ;; esac
        if ! prod_host; then
          case "$_l" in danbyte-web.service|danbyte-ws.service|danbyte-frontend-prod.service) continue ;; esac
        fi
        printf '%s\n' "$_l"
        ;;
    esac
  done <"$STATE_DIR/new-links"
}

loaded_of() {  # <unit...> -> the loaded ones
  for _u in "$@"; do unit_loaded "$_u" && printf '%s ' "$_u"; done
  return 0
}

all_timers() {  # every Danbyte timer either tree knows
  { tree_timers "$APP"; [ -d "${SRC:-/nonexistent}" ] && tree_timers "$SRC"; } \
    | tr ' ' '\n' | sed -n 's/^\(danbyte-[a-z0-9-]*\)$/\1.timer/p' | sort -u
}

# Stop timers, let a oneshot they started finish (up to 120 s), then the
# workers, then everything that serves.
stop_all() {
  # shellcheck disable=SC2046  # unit names: one word each
  _timers=$(loaded_of $(all_timers))
  if [ -n "$_timers" ]; then
    # shellcheck disable=SC2086
    sc stop $_timers || return 1
  fi
  _deadline=$(( $(now) + ${DANBYTE_UPGRADE_ONESHOT_WAIT:-120} ))
  for _t in $_timers; do
    _s="${_t%.timer}.service"
    while [ "$(sc is-active "$_s" 2>/dev/null)" = activating ] || [ "$(sc is-active "$_s" 2>/dev/null)" = active ]; do
      [ "$(now)" -lt "$_deadline" ] || break
      sleep 2
    done
  done
  _oneshots=""
  for _t in $_timers; do
    _s="${_t%.timer}.service"
    case "$(sc is-active "$_s" 2>/dev/null)" in active|activating|deactivating) _oneshots="$_oneshots $_s" ;; esac
  done
  if [ -n "$_oneshots" ]; then
    # shellcheck disable=SC2086
    sc stop $_oneshots || return 1
  fi
  # Restarts the UI scheduled just before the lock was taken.
  _svc=$(sc list-units --plain --no-legend --all 'danbyte-svc-*' 2>/dev/null | awk '{print $1}')
  if [ -n "$_svc" ]; then
    # shellcheck disable=SC2086
    sc stop $_svc || :
  fi
  # shellcheck disable=SC2046,SC2086
  _work=$(loaded_of $(printf '%s.service ' $UNITS_WORK))
  if [ -n "$_work" ]; then
    # shellcheck disable=SC2086
    sc stop $_work || return 1
  fi
  # shellcheck disable=SC2046,SC2086
  _web=$(loaded_of $(printf '%s.service ' $UNITS_WEB))
  if [ -n "$_web" ]; then
    # shellcheck disable=SC2086
    sc stop $_web || return 1
  fi
  for _u in $_timers $_work $_web; do
    case "$(sc is-active "$_u" 2>/dev/null)" in
      active|activating|deactivating|reloading) log "still running: $_u"; return 1 ;;
    esac
  done
  return 0
}

# start_units <no-block?> <unit...>: only the ones still loaded.
start_units() {
  _nb="$1"
  shift
  _set=$(loaded_of "$@")
  [ -n "$_set" ] || return 0
  if [ "$_nb" = 1 ]; then
    # shellcheck disable=SC2086
    sc start --no-block $_set
  else
    # shellcheck disable=SC2086
    sc start $_set
  fi
}

# A unit that crash-loops shows up as restarts: record the count right after
# the start, then require the same count and "active" a little later.
restart_counts() {  # <unit...>
  for _u in "$@"; do
    unit_loaded "$_u" && printf '%s %s\n' "$_u" "$(sc show -p NRestarts --value "$_u" 2>/dev/null)"
  done
  return 0
}

settled() {  # <file from restart_counts>
  while read -r _u _r0; do
    _a=$(sc show -p ActiveState --value "$_u" 2>/dev/null)
    _r=$(sc show -p NRestarts --value "$_u" 2>/dev/null)
    if [ "$_a" != active ] || [ "${_r:-0}" != "${_r0:-0}" ]; then
      # shellcheck disable=SC2034  # read by stage.sh
      SETTLE_DETAIL="$_u is ${_a:-unknown} after $(( ${_r:-0} - ${_r0:-0} )) restart(s)"
      return 1
    fi
  done <"$1"
  return 0
}

link_snapshot() {  # <file>: the danbyte-* unit links in the user's unit dir
  find "$SYSTEMD_DIR" -maxdepth 1 -name 'danbyte-*' -type l 2>/dev/null \
    | sed 's|.*/||' | LC_ALL=C sort >"$1"
}

# ── health ───────────────────────────────────────────────────────────────────

# Hosts the app answers to, from ALLOWED_HOSTS in .env.
app_hosts() {
  _h=$(sed -n 's/^ALLOWED_HOSTS=//p' "$APP/.env" 2>/dev/null | tail -n 1 | tr -d "'\"" | tr ',' ' ')
  _out=""
  for _x in $_h; do
    case "$_x" in '*') _x=127.0.0.1 ;; .*) _x="${_x#.}" ;; esac
    _out="$_out $_x"
  done
  printf '%s' "${_out:- 127.0.0.1 localhost}"
}

# app_health [version]: /api/health/ on 127.0.0.1:8000 answers 200 with
# status "ok" (and, given one, runs that version). HEALTH says what it saw.
app_health() {
  _want="${1:-}"
  HEALTH="no answer from 127.0.0.1:8000"
  for _h in $(app_hosts); do
    _code=$(curl -ks -m 5 -o "$WORK/health.json" -w '%{http_code}' -H "Host: $_h" \
      -H 'X-Forwarded-Proto: https' "http://127.0.0.1:8000/api/health/" 2>/dev/null) || _code=000
    if [ "$_code" != 200 ]; then
      HEALTH="HTTP $_code from /api/health/ (Host $_h)"
      continue
    fi
    _st=$(sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' "$WORK/health.json" | head -n 1)
    _ver=$(sed -n 's/.*"version" *: *"\([^"]*\)".*/\1/p' "$WORK/health.json" | head -n 1)
    HEALTH="status ${_st:-?}, version ${_ver:-?}"
    [ "$_st" = ok ] || return 1
    if [ -n "$_want" ] && [ "$(clean_ver "$_ver")" != "$(clean_ver "$_want")" ]; then
      HEALTH="$HEALTH, expected $_want"
      return 1
    fi
    return 0
  done
  return 1
}

wait_health() {  # <seconds> [version]
  _until=$(( $(now) + $1 ))
  while :; do
    app_health "${2:-}" && return 0
    [ "$(now)" -lt "$_until" ] || return 1
    sleep 3
  done
}

http_code() {  # <url> [curl args...]: "000" when nothing answers
  _url="$1"
  shift
  _c=$(curl -ks -m 5 -o /dev/null -w '%{http_code}' "$@" "$_url" 2>/dev/null)
  printf '%s' "${_c:-000}"
}

# ── the recovery units (copies, never links into a tree being swapped) ──────

install_recover() {
  mkdir -p "$UPG_ROOT/recover" "$SYSTEMD_DIR" || return 1
  cp -p "$HERE/lib.sh" "$HERE/recover.sh" "$HERE/dbtool.py" "$UPG_ROOT/recover/" || return 1
  _before=""
  for _u in $UNITS_WEB $UNITS_WORK; do _before="$_before $_u.service"; done
  cat >"$SYSTEMD_DIR/danbyte-upgrade-recover.service" <<EOF
# Written by the Danbyte upgrade stage; removed when the upgrade finishes.
# Finishes or rolls back an upgrade that was killed, before any app unit or
# timer starts at boot.
[Unit]
Description=Danbyte: finish or roll back an interrupted upgrade
ConditionPathExists=$MARK
Before=$_before timers.target

[Service]
Type=oneshot
TimeoutStartSec=3h
ExecStart=/bin/sh $UPG_ROOT/recover/recover.sh

[Install]
WantedBy=default.target
EOF
  cat >"$SYSTEMD_DIR/danbyte-upgrade-recover.timer" <<EOF
# Written by the Danbyte upgrade stage; removed when the upgrade finishes.
[Unit]
Description=Danbyte: look for an interrupted upgrade every 5 minutes

[Timer]
OnCalendar=*:0/5
AccuracySec=30s

[Install]
WantedBy=timers.target
EOF
  sc daemon-reload || return 1
  sc enable danbyte-upgrade-recover.service >/dev/null 2>&1 || return 1
  sc enable --now danbyte-upgrade-recover.timer >/dev/null 2>&1 || return 1
}

# This run's marker (or none): never tear down another run's recovery.
owns_mark() {
  [ ! -f "$MARK" ] || grep -qxF "WORK=$WORK" "$MARK"
}

remove_recover() {
  owns_mark || return 0
  sc disable --now danbyte-upgrade-recover.timer >/dev/null 2>&1 || :
  sc disable danbyte-upgrade-recover.service >/dev/null 2>&1 || :
  rm -f "$SYSTEMD_DIR/danbyte-upgrade-recover.service" "$SYSTEMD_DIR/danbyte-upgrade-recover.timer"
  sc daemon-reload >/dev/null 2>&1 || :
  rm -f "$MARK"
  rm -rf "$UPG_ROOT/recover"
}

# Nothing left to recover: the recovery's lock goes - each timer run during
# an upgrade leaves it - and so does the upgrade folder once it is empty.
tidy_root() {
  [ ! -f "$UPG_ROOT/active" ] || return 0
  rm -f "$UPG_ROOT/.recover.lock"
  rmdir "$UPG_ROOT" 2>/dev/null || :
}

# The stage process named in the marker is this very run, still alive.
stage_alive() {  # <pid> <starttime>: that very process, and not a zombie
  [ -n "$1" ] && [ -r "/proc/$1/stat" ] || return 1
  _ps=$(sed 's/^.*) //' "/proc/$1/stat")
  [ "${_ps%% *}" != Z ] && [ "$(printf '%s' "$_ps" | cut -d' ' -f20)" = "$2" ]
}

self_start() { sed 's/^.*) //' "/proc/$$/stat" | cut -d' ' -f20; }

# ── the swap and its undo ────────────────────────────────────────────────────

# move_aside <relative dir>: the live one into prev, the release's in its place.
move_in() {
  _d="$1"
  j_set moving "$_d"
  if [ -e "$APP/$_d" ] || [ -L "$APP/$_d" ]; then
    j_set had "$_d"
    mkdir -p "$(dirname "$PREV/$_d")" || return 1
    mv "$APP/$_d" "$PREV/$_d" || return 1
  fi
  if [ -e "$SRC/$_d" ]; then
    mkdir -p "$(dirname "$APP/$_d")" || return 1
    mv "$SRC/$_d" "$APP/$_d" || return 1
  fi
  j_set moved "$_d"
}

restore_dir() {  # <relative dir>
  _d="$1"
  if [ -e "$PREV/$_d" ] || [ -L "$PREV/$_d" ]; then
    rm -rf "${APP:?}/$_d"
    mkdir -p "$(dirname "$APP/$_d")"
    mv "$PREV/$_d" "$APP/$_d"
  elif ! j_list had | grep -qxF "$_d"; then
    rm -rf "${APP:?}/$_d"   # the release brought it; the one before had none
  fi
}

# The release's source files over the live tree (bundle): what is
# overwritten goes into a tar first, what is new into a list, and what the
# release no longer ships (per .release-files) into another tar.
overlay_tree() {
  (cd "$SRC" && find . \( -path ./vendor -o -path ./frontend/dist -o -path ./frontend/node_modules \
      -o -path ./staticfiles -o -path ./.git -o -name __pycache__ \) -prune -o \( -type f -o -type l \) -print) \
    | grep -v '^\./install\.sh$' | LC_ALL=C sort >"$STATE_DIR/new.list" || return 1
  : >"$STATE_DIR/overwrite.list"
  : >"$STATE_DIR/added.list"
  while IFS= read -r _f; do
    if [ -e "$APP/$_f" ] || [ -L "$APP/$_f" ]; then
      printf '%s\n' "$_f" >>"$STATE_DIR/overwrite.list"
    else
      printf '%s\n' "$_f" >>"$STATE_DIR/added.list"
    fi
  done <"$STATE_DIR/new.list"
  : >"$STATE_DIR/dropped.list"
  if [ -f "$APP/.release-files" ]; then
    # Only plain relative paths, and never what an install keeps.
    grep -E '^\./[A-Za-z0-9._/@+-]+$' "$APP/.release-files" | grep -v '/\.\./' \
      | grep -vE '^\./(\.env|\.venv/|media/|plugins_local/|vendor/|frontend/dist/|frontend/node_modules/|staticfiles/|\.git/)' \
      | LC_ALL=C sort | LC_ALL=C comm -23 - "$STATE_DIR/new.list" | while IFS= read -r _f; do
        if [ -f "$APP/$_f" ] || [ -L "$APP/$_f" ]; then printf '%s\n' "$_f"; fi
      done >"$STATE_DIR/dropped.list"
  fi
  j_set tree_saving 1
  tar -C "$APP" -cf "$PREV/overwritten.tar" --no-recursion -T "$STATE_DIR/overwrite.list" || return 1
  if [ -s "$STATE_DIR/dropped.list" ]; then
    tar -C "$APP" -cf "$PREV/dropped.tar" --no-recursion -T "$STATE_DIR/dropped.list" || return 1
  fi
  j_set tree_saved 1
  while IFS= read -r _f; do rm -f "${APP:?}/${_f#./}"; done <"$STATE_DIR/dropped.list"
  (cd "$SRC" && tar -cf - --no-recursion -T "$STATE_DIR/new.list") | tar -C "$APP" -xpf - || return 1
  j_set tree_applied 1
}

undo_overlay() {
  if [ -f "$STATE_DIR/added.list" ]; then
    while IFS= read -r _f; do
      case "$_f" in ./*) rm -f "${APP:?}/${_f#./}" ;; esac
    done <"$STATE_DIR/added.list"
    sed 's|/[^/]*$||' "$STATE_DIR/added.list" | LC_ALL=C sort -ru | while IFS= read -r _d; do
      case "$_d" in ./?*) rmdir "$APP/${_d#./}" 2>/dev/null || : ;; esac
    done
  fi
  if [ -f "$PREV/overwritten.tar" ]; then tar -C "$APP" -xpf "$PREV/overwritten.tar" || return 1; fi
  if [ -f "$PREV/dropped.tar" ]; then tar -C "$APP" -xpf "$PREV/dropped.tar" || return 1; fi
  return 0
}

# Put code, venv, vendor, frontend, static, .env and unit links back as
# they were. Renames and a checkout: seconds, safe under a TERM.
rollback_files() {
  _rc=0
  if [ -f "$STATE_DIR/new-links" ]; then
    while IFS= read -r _l; do
      [ -n "$_l" ] && rm -f "$SYSTEMD_DIR/$_l"
    done <"$STATE_DIR/new-links"
  fi
  if j_has deps_started && [ -d "$PREV/venv" ]; then
    rm -rf "$APP/.venv.failed"
    if [ -e "$APP/.venv" ]; then mv "$APP/.venv" "$APP/.venv.failed" || _rc=1; fi
    mv "$PREV/venv" "$APP/.venv" || _rc=1
    rm -rf "$APP/.venv.failed"
  fi
  _prev_sha=$(j_get git_prev)
  if [ -n "$_prev_sha" ]; then
    git -C "$APP" checkout -q -f "$_prev_sha" || _rc=1
    _br=$(j_get git_branch)
    if [ -n "$_br" ] && [ "$(git -C "$APP" rev-parse -q --verify "refs/heads/$_br" 2>/dev/null)" = "$_prev_sha" ]; then
      git -C "$APP" checkout -q "$_br" || _rc=1
    fi
  fi
  if j_has tree_saved; then undo_overlay || _rc=1; fi
  for _d in $(j_list moving | sed '1!G;h;$!d'); do restore_dir "$_d" || _rc=1; done
  if j_has env_saved && [ -f "$PREV/env" ]; then cp -p "$PREV/env" "$APP/.env" || _rc=1; fi
  sc daemon-reload >/dev/null 2>&1 || :
  j_set files_restored "$_rc"
  return "$_rc"
}

# ── the database ─────────────────────────────────────────────────────────────

# With the code that is on disk now (the previous release, after
# rollback_files). One retry: a restore that failed on a dropped connection
# usually works the second time.
db_restore() {
  _snap=$(j_get snapshot)
  if [ -z "$_snap" ] || [ ! -s "$_snap" ]; then
    DB_DETAIL="no snapshot was taken"
    return 1
  fi
  cd "$APP" || return 1
  run 330 "$PY" "$TOOL" wait-db 300 || { DB_DETAIL="the database did not answer: $(tail_out)"; return 1; }
  for _try in 1 2; do
    if run 7200 "$PY" "$TOOL" restore "$_snap"; then
      j_set db_restored 1
      return 0
    fi
    DB_DETAIL="$(tail_out)"
    log "restore attempt $_try failed"
  done
  return 1
}

alert_mail() {  # <subject> <text>
  [ -s "$WORK/mail.json" ] || return 0
  run 120 "$PY" "$TOOL" mail "$WORK/mail.json" "$1" "$2" || log "the alert mail failed: $(tail_out)"
}

# ── endings ──────────────────────────────────────────────────────────────────

# finish <done|failed> [open]: the final status, the log where it stays.
# "open" leaves the journal unfinished, for a person to recover.
finish() {
  FINISHED_AT=$(now)
  STEP_OPEN=0
  cp -p "$LOG" "$APP/.upgrade.log" 2>/dev/null && LOG_FINAL="$APP/.upgrade.log"
  [ "${2:-}" = open ] || j_set finished "$1"
  if [ "$1" = "done" ]; then status "done" "done" 100; else status failed "${FAILED_STEP:-$STEP}" 0; fi
}

cleanup_work() {  # keep the log and journal of a failed run, not its bulk
  rm -f "$WORK/mail.json" "$WORK/probe.hdr"
  rm -rf "${SRC:?}" "${PREV:?}" "$WORK/depcheck" "$WORK/wheels" "$WORK/snapshot.dump"
}

# Start what ran before, the way it ran: services first, then timers.
start_recorded() {  # <no-block?>
  # shellcheck disable=SC2046,SC2086
  start_units "$1" $(wanted service $UNITS_WEB) || return 1
  # shellcheck disable=SC2046,SC2086
  start_units "$1" $(wanted service $UNITS_WORK) || return 1
  # shellcheck disable=SC2046
  start_units "$1" $(wanted timer) || return 1
}

# Everything before "resume" goes back: files, then the database when it
# was touched, then the units. From "resume" on users are writing again, so
# a failure keeps the new release and says so (finish_forward).
rollback_all() {
  trap - EXIT
  trap '' INT TERM HUP
  FAILED_STEP="${FAILED_STEP:-$STEP}"
  step_end failed "${ERROR:-}"
  if j_has resumed; then
    finish_forward
    return
  fi
  if ! j_has quiesced; then
    OUTCOME=unchanged
    OUT_DB=unchanged
    OUT_SVC=running
    ERROR="${ERROR:-failed} - nothing was changed; the previous release keeps running."
    remove_recover
    finish failed
    cleanup_work
    tidy_root
    return
  fi
  status running rollback 0
  log "rolling back"
  stop_all || log "some units did not stop"
  rollback_files || warn "part of the previous files could not be put back - see the upgrade log"
  if db_touched; then
    if db_restore; then
      OUT_DB=restored
    else
      restore_failed "$DB_DETAIL"
      return
    fi
  else
    OUT_DB=unchanged
  fi
  if j_has started; then
    run 120 "$PY" "$TOOL" maintenance-off || warn "the maintenance flag could not be cleared; it expires by itself"
  fi
  OUT_SVC=running
  if [ "${NO_BLOCK:-0}" = 1 ]; then
    start_recorded 1 || warn "some units did not start"
  else
    start_recorded 0 || warn "some units did not start"
    if [ "$(j_get pre_health)" = ok ] && [ -n "$(wanted service danbyte-web danbyte-backend)" ]; then
      wait_health "${DANBYTE_UPGRADE_HEALTH_WAIT:-120}" || { OUT_SVC=unhealthy; warn "the previous release did not come back healthy: $HEALTH"; }
    fi
  fi
  OUTCOME=restored
  if [ "$OUT_DB" = restored ]; then
    ERROR="${ERROR:-failed} - rolled back: the previous release runs again and the database was restored from the snapshot taken before the migration."
  else
    ERROR="${ERROR:-failed} - rolled back: the previous release runs again; the database was not changed."
  fi
  j_set rolled_back 1
  remove_recover
  finish failed
  cleanup_work
  tidy_root
}

restore_failed() {  # <detail>
  OUTCOME=restore_failed
  OUT_DB=restore_failed
  OUT_SVC=stopped
  j_set restore_failed 1
  # Nothing may start on this database, not even at the next boot.
  for _u in $(wanted service) $(wanted timer); do
    sc disable "$_u" >/dev/null 2>&1 && printf '%s\n' "$_u" >>"$STATE_DIR/disabled"
  done
  _b="${BACKUP_ID:-}"
  ERROR="${ERROR:-failed} - and the database could not be restored from the snapshot ($1). Danbyte is stopped. Run: danbyte-admin upgrade recover${_b:+ (or restore the pre-upgrade backup $_b)}."
  alert_mail "Upgrade to ${VERSION:-?} failed and Danbyte is stopped" "$ERROR"
  finish failed open
}

# The new release stays: start what should run, clear the flag, report.
finish_forward() {
  trap - EXIT
  trap '' INT TERM HUP
  if [ "${NO_BLOCK:-0}" = 1 ]; then _nb=1; else _nb=0; fi
  run 120 "$PY" "$TOOL" maintenance-off || :
  start_recorded "$_nb" || warn "some units did not start"
  for _u in $(new_units service) $(new_units timer); do
    sc enable "$_u" >/dev/null 2>&1 || :
  done
  # shellcheck disable=SC2046
  start_units "$_nb" $(new_units service) $(new_units timer) || :
  OUTCOME=new
  if db_touched; then OUT_DB=migrated; else OUT_DB=unchanged; fi
  OUT_SVC=running
  [ -n "${ERROR:-}" ] && warn "$ERROR"
  ERROR=""
  remove_recover
  finish "done"
  cleanup_work
  tidy_root
}
