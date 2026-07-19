#!/usr/bin/env bash
# Relocate an existing Danbyte install to a new service-user home (default
# /opt/danbyte) and switch on /var/log/danbyte file logging. Run as root:
#
#   sudo ./scripts/danbyte-relocate.sh                 # → /opt/danbyte
#   sudo ./scripts/danbyte-relocate.sh --to /opt/danbyte --user danbyte
#
# This is OPTIONAL. Version upgrades work fine wherever Danbyte already lives —
# the systemd units are home-relative (%h/danbyte). This only changes WHERE it
# lives to match the current default layout. The database is never touched.
#
# What it does: stop the services → move the service user's home (contents and
# all, via `usermod -m`) → repoint the nginx static/media/maintenance roots →
# create /var/log/danbyte + set DANBYTE_LOG_DIR → restart → healthcheck.
#
# Back up first (the DB especially) and read this through before running.
set -euo pipefail

SERVICE_USER="${SERVICE_USER:-danbyte}"
NEW_HOME="/opt/danbyte"
LOG_DIR="${DANBYTE_LOG_DIR:-/var/log/danbyte}"
while [ $# -gt 0 ]; do
  case "$1" in
    --to) NEW_HOME="$2"; shift 2 ;;
    --to=*) NEW_HOME="${1#*=}"; shift ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --user=*) SERVICE_USER="${1#*=}"; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./scripts/danbyte-relocate.sh)"
id -u "$SERVICE_USER" >/dev/null 2>&1 || die "no such user: $SERVICE_USER"

OLD_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
SVC_UID="$(id -u "$SERVICE_USER")"
[ -n "$OLD_HOME" ] || die "could not resolve $SERVICE_USER's home"

MOVE=1
if [ "$OLD_HOME" = "$NEW_HOME" ]; then
  MOVE=0
  echo "Home already at $NEW_HOME — will only (re)apply logging + nginx paths."
else
  [ -d "$OLD_HOME/danbyte" ] || die "no app at $OLD_HOME/danbyte — wrong --user?"
  [ -e "$NEW_HOME" ] && die "$NEW_HOME already exists — move/remove it first."
fi
APP="$NEW_HOME/danbyte"

# Run a command as the service user with a working `systemctl --user`. $1 = HOME.
as_user() {
  local home="$1"; shift
  sudo -u "$SERVICE_USER" env \
    HOME="$home" USER="$SERVICE_USER" \
    XDG_RUNTIME_DIR="/run/user/$SVC_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SVC_UID/bus" \
    "$@"
}

# Whichever units this install actually has (dev: danbyte-backend; prod: web/ws
# /frontend-prod). Timers follow their .service, so this list is enough.
UNITS="danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-docs danbyte-backend"
have_units() { for u in $UNITS; do as_user "$1" systemctl --user cat "$u" >/dev/null 2>&1 && printf '%s ' "$u"; done; }

step "Stopping Danbyte services"
PRESENT="$(have_units "$OLD_HOME")"
[ -n "$PRESENT" ] && as_user "$OLD_HOME" systemctl --user stop $PRESENT || true

if [ "$MOVE" -eq 1 ]; then
  step "Moving $OLD_HOME → $NEW_HOME"
  # Stop the user's systemd manager so nothing holds the old home open; linger
  # will spin it back up rooted at the new $HOME.
  loginctl disable-linger "$SERVICE_USER" 2>/dev/null || true
  loginctl terminate-user "$SERVICE_USER" 2>/dev/null || true
  sleep 2
  # -m moves the home directory's contents; -d updates the passwd entry.
  usermod -m -d "$NEW_HOME" "$SERVICE_USER"
  chmod 755 "$NEW_HOME"
  chmod o+x "$NEW_HOME" "$APP" 2>/dev/null || true   # let nginx traverse to staticfiles
  loginctl enable-linger "$SERVICE_USER"
  # Wait for the user manager (linger spins it up) before touching --user units.
  for _ in $(seq 1 20); do [ -S "/run/user/$SVC_UID/bus" ] && break; sleep 0.5; done
fi

step "Log dir $LOG_DIR + DANBYTE_LOG_DIR in .env"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$LOG_DIR"
if [ -f "$APP/.env" ] && ! grep -qE '^DANBYTE_LOG_DIR=' "$APP/.env"; then
  printf '\nDANBYTE_LOG_DIR=%s\n' "$LOG_DIR" >> "$APP/.env"
  echo "  added DANBYTE_LOG_DIR=$LOG_DIR"
fi

if [ "$MOVE" -eq 1 ]; then
  step "Repointing nginx roots ($OLD_HOME → $NEW_HOME)"
  changed=0
  for f in /etc/nginx/sites-available/danbyte.conf \
           /etc/nginx/sites-available/* /etc/nginx/conf.d/*.conf; do
    [ -f "$f" ] || continue
    if grep -q "$OLD_HOME/" "$f" 2>/dev/null; then
      sed -i "s#$OLD_HOME/#$NEW_HOME/#g" "$f"; changed=1; echo "  patched $f"
    fi
  done
  if [ "$changed" -eq 1 ]; then
    nginx -t && systemctl reload nginx && echo "  nginx reloaded"
  else
    echo "  no nginx site referenced $OLD_HOME (skipped)"
  fi
fi

step "Reloading + starting services"
as_user "$NEW_HOME" systemctl --user daemon-reload
PRESENT="$(have_units "$NEW_HOME")"
[ -n "$PRESENT" ] && as_user "$NEW_HOME" systemctl --user start $PRESENT || true

step "Healthcheck"
sleep 3
code="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/ 2>/dev/null || echo 000)"
echo "  backend 127.0.0.1:8000 → HTTP $code"

cat <<EOF

$(printf '\033[1;32m✓ Relocation complete.\033[0m')

  App:  $APP
  Logs: $LOG_DIR/danbyte.log  (+ gunicorn-*.log)

Verify:
  sudo -u $SERVICE_USER XDG_RUNTIME_DIR=/run/user/$SVC_UID \\
    systemctl --user status danbyte-web danbyte-workers
  tail -f $LOG_DIR/*.log

If anything looks wrong, the old home is gone (moved, not copied) — restore from
your backup, or move it back:  sudo usermod -m -d "$OLD_HOME" $SERVICE_USER
EOF
