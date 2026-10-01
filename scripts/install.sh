#!/usr/bin/env bash
# Danbyte one-shot installer - turns a fully-offline release bundle into a
# running production install. Run as root from inside the unpacked bundle:
#
#   tar xzf danbyte-<version>-linux-x86_64.tar.gz
#   cd danbyte-<version>-linux-x86_64
#   sudo ./install.sh --host danbyte.example.com
#
# It: installs OS services (postgres/redis/nginx), creates the dedicated
# `danbyte` user under /opt, deploys the app to /opt/danbyte/danbyte, builds the
# venv from the bundled wheelhouse + CPython, generates secrets, creates the DB,
# migrates + bootstraps an admin, installs the systemd units, writes logs to
# /var/log/danbyte, and puts nginx/TLS in front.
#
# Offline scope: no PyPI/npm/python.org access needed (all bundled). OS packages
# (postgresql, redis-server, nginx) still come from your distro - on an airgapped
# box, point apt at your local mirror first, or pre-install them.
#
# Re-run on a box that already runs Danbyte, it UPGRADES: the root steps as
# above, then the bundle's own upgrade stage (scripts/upgrade/stage.sh) as the
# service user's transient unit danbyte-upgrade.service - the same stage the
# in-app upgrade runs: services stopped first, a snapshot, one-transaction
# migrations, a verify before anything serves, and everything put back if a
# step fails. A dropped SSH session does not stop it. Then nginx, logrotate
# and the certificate unit from this bundle (scripts/host-sync.sh). Root only
# ever runs files from this bundle, never from the app directory.
set -euo pipefail

# ── Config (env or flags) ────────────────────────────────────────────────────
SERVICE_USER="${SERVICE_USER:-danbyte}"
# Empty = auto-detect below. /opt/danbyte is only the default for a NEW install;
# an existing install must keep living wherever it already is.
SERVICE_HOME="${SERVICE_HOME:-}"
SERVICE_HOME_DEFAULT="/opt/danbyte"
LOG_DIR="${DANBYTE_LOG_DIR:-/var/log/danbyte}"
HOST="${DANBYTE_HOST:-}"
UNATTENDED=0
DO_NGINX=1
FORCE=0
SKIP_BACKUP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --service-home) SERVICE_HOME="$2"; shift 2 ;;
    --no-nginx) DO_NGINX=0; shift ;;
    --unattended|-y) UNATTENDED=1; shift ;;
    --force) FORCE=1; shift ;;
    --skip-backup) SKIP_BACKUP=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# App-level transport hardening (Secure cookies / HSTS / http→https) belongs ON
# only when there's TLS in front. With --no-nginx there's no terminator, so
# forcing it True would make the browser drop the session cookie → login loop.
if [ "$DO_NGINX" -eq 1 ]; then HTTPS_VAL=True; else HTTPS_VAL=False; fi

# Resolve where this install lives. Re-running the installer to upgrade must
# find the EXISTING install, not assume the current default: older installs live
# under /srv/danbyte (or a custom --service-home), and the service user already
# carries that path as its home. Hard-coding /opt here made the upgrade abort on
# `chmod 755 /opt/danbyte: No such file or directory` for every such box.
# Priority: explicit flag/env > existing service user's home > /opt default.
if [ -z "$SERVICE_HOME" ]; then
  if id -u "$SERVICE_USER" >/dev/null 2>&1; then
    SERVICE_HOME="$(getent passwd "$SERVICE_USER" | cut -d: -f6)"
  fi
  SERVICE_HOME="${SERVICE_HOME:-$SERVICE_HOME_DEFAULT}"
fi
APP="$SERVICE_HOME/danbyte"
BUNDLE="$(cd "$(dirname "$0")" && pwd)"

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./install.sh)"
[ -d "$BUNDLE/vendor/wheels" ] && [ -x "$BUNDLE/vendor/python/bin/python3" ] \
  || die "this doesn't look like an offline bundle (missing vendor/)."
[ "$(stat -c %u "$BUNDLE/install.sh")" -eq 0 ] \
  || warn "the bundle's files are not owned by root; whoever owns them could change what root runs next - extract it as root (tar is run by root) or chown -R root: it"
EXISTING=0
if [ -f "$APP/manage.py" ] && [ -f "$APP/.env" ]; then
  EXISTING=1
  [ ! -d "$APP/.git" ] || [ "$FORCE" -eq 1 ] \
    || die "$APP is a git checkout - upgrade it from Settings -> Updates or with danbyte-admin upgrade, not with a bundle (--force to overlay it anyway)."
  if [ -z "$HOST" ] && [ -f /etc/nginx/sites-available/danbyte.conf ]; then
    # Keep the name the site already answers to.
    HOST="$(sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;]*\);.*/\1/p' /etc/nginx/sites-available/danbyte.conf | head -n 1)"
  fi
fi
[ -n "$HOST" ] || HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$HOST" ] || die "could not determine a host; pass --host <name-or-ip>"
ADMIN_LOGIN="$(logname 2>/dev/null || echo "${SUDO_USER:-}")"

# ── 1. OS services ───────────────────────────────────────────────────────────
# nginx is only needed when this installer manages the TLS front end; --no-nginx
# means you terminate TLS elsewhere (or run direct), so don't require it.
# `make` drives the service/proxy install steps below (make install-services,
# proxy-install); a minimal server won't have it, so install it like any other
# OS dependency rather than assuming it's present.
if [ "$DO_NGINX" -eq 1 ]; then
  step "OS packages (postgresql, redis-server, nginx, make)"
  PKGS="postgresql redis-server nginx make"
  CHECK_BINS="psql redis-server nginx make"
else
  step "OS packages (postgresql, redis-server, make) - skipping nginx (--no-nginx)"
  PKGS="postgresql redis-server make"
  CHECK_BINS="psql redis-server make"
fi
need_pkg=0
for b in $CHECK_BINS; do command -v "$b" >/dev/null 2>&1 || need_pkg=1; done
if [ "$need_pkg" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    # A fresh image's package lists are usually older than the archive;
    # without a refresh the install fails on 404s for packages that moved.
    DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
    DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS \
      || die "apt could not install $PKGS - install them, then re-run."
  else
    die "$PKGS missing and apt-get not found - pre-install them."
  fi
fi
systemctl enable --now postgresql redis-server >/dev/null 2>&1 || true

# WeasyPrint (label-template PDFs) renders via Pango/cairo/GDK-PixBuf shared
# libraries - pip can't provide them. Install idempotently when apt is present so
# label printing works on fresh installs and existing upgrades alike.
if command -v apt-get >/dev/null 2>&1; then
  step "PDF rendering libraries (WeasyPrint: pango/cairo/gdk-pixbuf)"
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libpango-1.0-0 libpangocairo-1.0-0 libcairo2 libgdk-pixbuf-2.0-0 \
    libffi8 fonts-dejavu-core \
    || warn "Could not install WeasyPrint libraries - label PDF printing may fail until they're present."
fi

# ── 2. Node runtime (bundled → /usr/bin/node if the host's is missing/too old) ─
# rolldown-vite's native binding is engine-gated to Node ≥ 20.19; a stale system
# node makes `vite preview` (the frontend unit) crash at boot. So don't accept
# just any existing node - install the bundled runtime whenever the host's is
# absent OR below the floor.
step "Node runtime"
NODE_MIN_MAJOR=20
NODE_MIN_MINOR=19
install_bundled_node() {
  install -d /opt/danbyte-node
  cp -a "$BUNDLE/vendor/node/." /opt/danbyte-node/
  ln -sfn /opt/danbyte-node/bin/node /usr/bin/node
  ln -sfn /opt/danbyte-node/bin/npm  /usr/bin/npm
  echo "  installed bundled node → /usr/bin/node ($(/usr/bin/node -v))"
}
# Check the EXACT binary the systemd units call (/usr/bin/node), not whatever
# `node` resolves to on PATH - a new node at /usr/local/bin won't help a unit
# hardcoded to /usr/bin/node.
NODE_BIN=/usr/bin/node
node_ok() {
  [ -x "$NODE_BIN" ] || return 1
  local v major minor
  v="$("$NODE_BIN" -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"
  minor="${v#*.}"; minor="${minor%%.*}"
  [ -n "$major" ] || return 1
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ]
}
if node_ok; then
  echo "  using existing $NODE_BIN ($("$NODE_BIN" -v))"
else
  if [ -e "$NODE_BIN" ]; then
    echo "  $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo unknown)) is below the ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} floor - installing bundled node"
  fi
  install_bundled_node
fi

# ── 3. Service user ──────────────────────────────────────────────────────────
step "Service user '$SERVICE_USER' ($SERVICE_HOME)"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "Danbyte service" --home "$SERVICE_HOME" "$SERVICE_USER"
fi
loginctl enable-linger "$SERVICE_USER"
[ -n "$ADMIN_LOGIN" ] && [ "$ADMIN_LOGIN" != "root" ] && usermod -aG "$SERVICE_USER" "$ADMIN_LOGIN" || true
# Create-if-missing + set mode in one step. A bare `chmod` aborts the whole run
# under `set -e` when the home doesn't exist yet (e.g. the account was made
# without one), which is never worth failing an upgrade over.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$SERVICE_HOME"
SVC_UID="$(id -u "$SERVICE_USER")"

# Log directory - the app (running as the service user) writes danbyte.log +
# gunicorn logs here; see settings.LOGGING / deploy/gunicorn.conf.py.
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 755 "$LOG_DIR"

# Run a command as the service user with a working `systemctl --user`.
as_user() {
  sudo -u "$SERVICE_USER" env \
    HOME="$SERVICE_HOME" USER="$SERVICE_USER" \
    XDG_RUNTIME_DIR="/run/user/$SVC_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$SVC_UID/bus" \
    "$@"
}
# Wait for the user manager (linger spins it up) so systemctl --user works.
for _ in $(seq 1 20); do [ -S "/run/user/$SVC_UID/bus" ] && break; sleep 0.5; done

# Unprivileged ICMP: the monitoring workers ping via SOCK_DGRAM ICMP (no
# cap_net_raw), which the kernel only allows for gids inside
# net.ipv4.ping_group_range. Grant the service group so scans/pings work.
SVC_GID="$(id -g "$SERVICE_USER")"
echo "net.ipv4.ping_group_range = $SVC_GID $SVC_GID" \
  > /etc/sysctl.d/99-danbyte-icmp.conf
sysctl -q -w "net.ipv4.ping_group_range=$SVC_GID $SVC_GID" || true

# ── Existing install: the bundle's upgrade stage does steps 4-9 ─────────────
upgrade_existing() {
  local root work ver from now lock unit_state mark rc state step last
  step "Upgrading the existing install in $APP"
  root="$(dirname "$APP")/.danbyte-upgrade"
  [ "$(stat -c %d "$(dirname "$APP")")" = "$(stat -c %d "$APP")" ] || root="$APP/.danbyte-upgrade"
  mark="$root/active"
  [ ! -f "$mark" ] || die "an earlier upgrade is unfinished - run: danbyte-admin upgrade recover"
  unit_state="$(as_user systemctl --user is-active danbyte-upgrade.service 2>/dev/null || true)"
  if [ "$unit_state" = active ] || [ "$unit_state" = activating ]; then
    [ "$FORCE" -eq 1 ] || die "danbyte-upgrade.service is running - wait for it, or pass --force"
  fi
  lock="$APP/.upgrade.lock"
  if [ -e "$lock" ]; then
    # The app's rule: a lock whose unit is gone and that is older than five
    # minutes is stale.
    if [ $(( $(date +%s) - $(stat -c %Y "$lock") )) -lt 300 ] && [ "$FORCE" -eq 0 ]; then
      die "an upgrade holds $lock - wait for it, or pass --force"
    fi
    as_user rm -f "$lock"
  fi
  ver="$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$BUNDLE/danbyte/__init__.py")"
  from="$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$APP/danbyte/__init__.py")"
  [ -f "$BUNDLE/scripts/upgrade/stage.sh" ] || die "this bundle has no upgrade stage"
  # The stage's own order (a pre-release is older than its final), from this
  # bundle. --force does not cover it: older code on a newer schema.
  if /bin/sh -c '. "$1" && downgrade_refused "$2" "$3" >/dev/null' _ \
      "$BUNDLE/scripts/upgrade/lib.sh" "$ver" "$from"; then
    die "this bundle is $ver and $APP runs $from - downgrades are not supported"
  fi
  # The previous release's nginx template, to tell whether the live site
  # was edited by hand (host-sync.sh) once the stage has replaced it.
  OLD_TEMPLATE="$(mktemp)"
  cp "$APP/deploy/nginx/danbyte.prod.conf.template" "$OLD_TEMPLATE" 2>/dev/null || : >"$OLD_TEMPLATE"
  now="$(date +%s)"
  work="$root/$(date -u +%Y%m%dT%H%M%SZ)-$ver"
  as_user mkdir -p "$work/src"
  # Copied by the service user through a pipe: the admin's home is often
  # closed to it, and nothing it will run is left owned by root.
  tar -C "$BUNDLE" -cf - . | as_user tar -C "$work/src" -xf -
  # The same lock the app takes, so the Updates page and the auto-upgrade
  # timer see this upgrade as busy - written by the service user.
  as_user flock "$APP/.upgrade.lock.guard" sh -c \
    'umask 077; printf "%s" "$1" >"$2.tmp" && mv -f "$2.tmp" "$2"' _ \
    "{\"owner\":\"installer-$now\",\"phase\":\"launched\",\"via\":\"systemd-run\",\"launch_confirmed\":true,\"acquired_at\":$now,\"launched_at\":$now}" \
    "$lock"
  as_user sh -c 'printf "%s\n" "$1" >"$2"' _ \
    "{\"state\":\"running\",\"step\":\"launching\",\"pct\":0,\"version_to\":\"$ver\",\"version_from\":\"$from\",\"stage_api\":1,\"trigger\":\"installer\",\"started_at\":$now}" \
    "$APP/.upgrade-status.json"
  set -- systemd-run --user --collect --unit danbyte-upgrade \
    -p KillMode=mixed -p TimeoutStopSec=300 \
    --setenv=DANBYTE_DIR="$APP" --setenv=DANBYTE_UPGRADE_WORK="$work" \
    --setenv=DANBYTE_UPGRADE_SRC="$work/src" --setenv=DANBYTE_UPGRADE_VERSION="$ver" \
    --setenv=DANBYTE_UPGRADE_FROM="$from" --setenv=DANBYTE_UPGRADE_TRIGGER=installer \
    --setenv=DANBYTE_UPGRADE_STARTED_AT="$now"
  [ "$SKIP_BACKUP" -eq 1 ] && set -- "$@" --setenv=DANBYTE_SKIP_BACKUP=1
  if ! as_user "$@" -p OnFailure=danbyte-upgrade-recover.service \
      /bin/sh "$work/src/scripts/upgrade/stage.sh" --kind bundle >/dev/null 2>&1; then
    unit_state="$(as_user systemctl --user is-active danbyte-upgrade.service 2>/dev/null || true)"
    if [ "$unit_state" != active ] && [ "$unit_state" != activating ]; then
      # An older systemd without OnFailure= on transient units: the stage's
      # recovery timer covers it.
      as_user "$@" /bin/sh "$work/src/scripts/upgrade/stage.sh" --kind bundle >/dev/null \
        || { as_user rm -f "$lock"; die "could not start danbyte-upgrade.service"; }
    fi
  fi
  echo "  running as danbyte-upgrade.service - it carries on if this session drops."
  echo "  follow it: sudo -u $SERVICE_USER XDG_RUNTIME_DIR=/run/user/$SVC_UID journalctl --user -fu danbyte-upgrade"
  last=""
  while :; do
    sleep 2
    state="$(sed -n 's/.*"state": *"\([a-z]*\)".*/\1/p' "$APP/.upgrade-status.json" 2>/dev/null)"
    step="$(sed -n 's/.*"step": *"\([a-z_]*\)".*/\1/p' "$APP/.upgrade-status.json" 2>/dev/null)"
    if [ -n "$step" ] && [ "$step" != "$last" ]; then echo "  - $step"; last="$step"; fi
    unit_state="$(as_user systemctl --user is-active danbyte-upgrade.service 2>/dev/null || true)"
    if [ "$state" != running ] && [ "$unit_state" != active ] && [ "$unit_state" != activating ]; then
      break
    fi
    if [ "$state" = running ] && [ "$unit_state" != active ] && [ "$unit_state" != activating ] \
        && [ -z "$(as_user systemctl --user show -p MainPID --value danbyte-upgrade.service 2>/dev/null | grep -v '^0$')" ] \
        && [ ! -f "$mark" ]; then
      break
    fi
    if [ "$state" = running ] && [ "$unit_state" != active ] && [ "$unit_state" != activating ] && [ -f "$mark" ]; then
      warn "the upgrade stopped part-way; its recovery finishes or rolls it back within five minutes."
      break
    fi
  done
  as_user rm -f "$lock"
  rc=1
  [ "$state" = "done" ] && rc=0
  if [ "$rc" -ne 0 ]; then
    printf '\n\033[1;31m✗ The upgrade to %s failed.\033[0m\n' "$ver" >&2
    sed -n 's/.*"error": *"\([^"]*\)".*/  \1/p' "$APP/.upgrade-status.json" >&2
    echo "  log: $APP/.upgrade.log" >&2
    rm -f "$OLD_TEMPLATE"
    exit 1
  fi
  echo "  upgraded $from -> $ver"
}

if [ "$EXISTING" -eq 1 ]; then
  # Settings releases from before 0.17 did not backfill themselves.
  grep -qE '^DANBYTE_HTTPS=' "$APP/.env" \
    || printf '\nDANBYTE_HTTPS=%s\n' "$HTTPS_VAL" >>"$APP/.env"
  upgrade_existing
  ADMIN_PASSWORD=""
fi

if [ "$EXISTING" -eq 0 ]; then
# ── 4. Deploy the app to $APP ────────────────────────────────────────────────
step "Deploying app → $APP"
install -d "$APP"
# Everything except the outer installer copy; keep vendor/ (python+wheels+node).
tar -C "$BUNDLE" --exclude=./install.sh -cf - . | tar -C "$APP" -xf -
chown -R "$SERVICE_USER:$SERVICE_USER" "$SERVICE_HOME"
chmod o+x "$SERVICE_HOME" "$APP"   # let nginx traverse to staticfiles

# ── 5. Python venv from the bundled wheelhouse ───────────────────────────────
step "Python venv (offline wheelhouse)"
as_user bash -lc "cd '$APP' && vendor/python/bin/python3 -m venv .venv \
  && .venv/bin/pip install --no-index --find-links vendor/wheels -r requirements.txt >/dev/null"

# ── 6. Secrets + .env (reuse existing on re-run) ─────────────────────────────
step "Configuring .env"
PYGEN="$APP/vendor/python/bin/python3"
if [ -f "$APP/.env" ]; then
  echo "  keeping existing $APP/.env"
  DB_PASSWORD="$(grep -E '^DB_PASSWORD=' "$APP/.env" | cut -d= -f2-)"
  ADMIN_PASSWORD="$(grep -E '^DJANGO_SUPERUSER_PASSWORD=' "$APP/.env" | cut -d= -f2- || true)"
  # Backfill DANBYTE_LOG_DIR for installs that predate file logging.
  grep -qE '^DANBYTE_LOG_DIR=' "$APP/.env" \
    || printf '\nDANBYTE_LOG_DIR=%s\n' "$LOG_DIR" >> "$APP/.env"
  # Backfill MONITORING_SECRET_KEY (now required when DEBUG=False) for installs
  # that predate it - a fresh random key; existing secrets were encrypted under
  # the SECRET_KEY-derived key, so preserve behaviour by seeding it FROM the
  # current SECRET_KEY (keeps existing SNMP/SMTP/LDAP secrets decryptable).
  grep -qE '^MONITORING_SECRET_KEY=' "$APP/.env" \
    || printf '\nMONITORING_SECRET_KEY=%s\n' \
       "$(grep -E '^DJANGO_SECRET_KEY=' "$APP/.env" | cut -d= -f2-)" >> "$APP/.env"
  # Backfill DANBYTE_HTTPS to match this install's front end: True when nginx +
  # TLS is managed here, False for --no-nginx (no terminator → Secure cookies
  # would break login). Defaults off in settings so plain-http is never locked out.
  grep -qE '^DANBYTE_HTTPS=' "$APP/.env" \
    || printf '\nDANBYTE_HTTPS=%s\n' "$HTTPS_VAL" >> "$APP/.env"
else
  SECRET_KEY="$("$PYGEN" -c 'import secrets;print(secrets.token_urlsafe(50))')"
  MONITORING_SECRET_KEY="$("$PYGEN" -c 'import secrets;print(secrets.token_urlsafe(50))')"
  DB_PASSWORD="$("$PYGEN" -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(24)))')"
  ADMIN_PASSWORD="$("$PYGEN" -c 'import secrets,string;print("".join(secrets.choice(string.ascii_letters+string.digits) for _ in range(20)))')"
  umask 077
  cat > "$APP/.env" <<EOF
DJANGO_SECRET_KEY=$SECRET_KEY
DEBUG=False
ALLOWED_HOSTS=$HOST,127.0.0.1,localhost

# Transport hardening (Secure cookies, HSTS, http->https): on when this install
# manages nginx + TLS, off for --no-nginx (no terminator → Secure cookies would
# drop the session and loop login). Flip to True once you put TLS in front.
DANBYTE_HTTPS=$HTTPS_VAL

# Encrypts stored SNMP/SSH/SMTP/LDAP credentials; required when DEBUG=False.
# Do NOT change once credentials are stored - old ciphertext becomes unreadable.
MONITORING_SECRET_KEY=$MONITORING_SECRET_KEY

DB_NAME=danbyte
DB_USER=danbyte
DB_PASSWORD=$DB_PASSWORD
DB_HOST=127.0.0.1
DB_PORT=5432

REDIS_URL=redis://localhost:6379/0

DANBYTE_LOG_DIR=$LOG_DIR

DJANGO_SUPERUSER_USERNAME=admin
DJANGO_SUPERUSER_EMAIL=admin@$HOST
DJANGO_SUPERUSER_PASSWORD=$ADMIN_PASSWORD
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$APP/.env"
  chmod 600 "$APP/.env"
fi

# ── 7. PostgreSQL role + database (idempotent) ───────────────────────────────
step "PostgreSQL role + database"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='danbyte'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE ROLE danbyte LOGIN PASSWORD '$DB_PASSWORD'"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='danbyte'" | grep -q 1 \
  || sudo -u postgres psql -qc "CREATE DATABASE danbyte OWNER danbyte"

# ── 8. Migrate + bootstrap + static (offline; reads .env) ────────────────────
step "Migrate + bootstrap"
as_user bash -lc "cd '$APP' && .venv/bin/python manage.py migrate --noinput \
  && .venv/bin/python manage.py bootstrap \
  && .venv/bin/python manage.py collectstatic --noinput >/dev/null \
  && chmod -R u=rwX,go=rX staticfiles"   # nginx reads them from disk

# ── 9. systemd units ─────────────────────────────────────────────────────────
step "Installing + (re)starting services"
# ONLY the production unit set. This used to also run `install-services`, which
# links the dev units - including danbyte-infra, the docker-compose Postgres +
# Redis stack. On a host that already ran Postgres that left an idle, empty
# container competing for 5432 (issue #14).
as_user bash -lc "cd '$APP' && make install-prod-services >/dev/null"

# `danbyte` on PATH, so an administrator over SSH does not have to know where
# the app was installed. A symlink rather than a shell alias: an alias exists
# only in an interactive shell that sourced it, so it would be missing from
# sudo, cron and every non-login session - exactly when this is wanted.
# -f so a re-install or an upgrade re-points it instead of failing.
if [ -d /usr/local/bin ]; then
  ln -sfn "$APP/scripts/danbyte-admin" /usr/local/bin/danbyte
fi
DANBYTE_UNITS="danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-fastlane danbyte-docs"
# enable = start at boot; restart = pick up freshly-deployed code (a plain
# `enable --now` is a no-op on already-running units, so a re-install/upgrade
# would keep serving the OLD code - restart is what makes the update take).
as_user systemctl --user enable $DANBYTE_UNITS >/dev/null 2>&1 || true
as_user systemctl --user restart $DANBYTE_UNITS
# What this bundle installed, so the first upgrade can remove the files the
# next release no longer ships.
as_user sh -c 'cd "$1" && find . \( -path ./vendor -o -path ./frontend/dist -o -path ./frontend/node_modules -o -path ./staticfiles -o -path ./.git -o -path ./.venv -o -path ./media -o -path ./plugins_local -o -name __pycache__ \) -prune -o \( -type f -o -type l \) -print | grep -v "^\./install\.sh$\|^\./\.env$\|^\./\.release-files" | LC_ALL=C sort >.release-files.tmp && mv -f .release-files.tmp .release-files' _ "$APP" || true
fi

# ── 10. logrotate, nginx + TLS, the certificate unit (from this bundle) ──────
# Rotation for the log files: the app rotates nothing itself when this
# exists (#231). The nginx site and the root unit that applies a certificate
# the app drops (Settings → Updates → Site certificate). Rendered from this
# bundle as root; nothing from the app directory runs as root.
step "Host: logrotate$( [ "$DO_NGINX" -eq 1 ] && echo ", nginx + TLS for $HOST, certificate unit")"
set -- --app "$APP" --user "$SERVICE_USER" --host "$HOST" --log-dir "$LOG_DIR"
[ "$DO_NGINX" -eq 1 ] || set -- "$@" --no-nginx
if [ "$EXISTING" -eq 1 ]; then
  set -- "$@" --old-template "$OLD_TEMPLATE"
else
  set -- "$@" --fresh
fi
bash "$BUNDLE/scripts/host-sync.sh" "$@"
[ "$EXISTING" -eq 1 ] && rm -f "$OLD_TEMPLATE"

# ── Done ─────────────────────────────────────────────────────────────────────
if [ "$DO_NGINX" -eq 1 ]; then
  URL="https://$HOST/"
else
  # No managed terminator - the app serves plain HTTP on the frontend port.
  URL="http://$HOST:3000/  (no nginx; put your own TLS in front, then set DANBYTE_HTTPS=True)"
fi
cat <<EOF

$(printf '\033[1;32m✓ Danbyte is installed.\033[0m')

  URL:      $URL
  Admin:    admin
  Password: ${ADMIN_PASSWORD:-<existing>}

Next:
  • Sign in, then change the admin password (User → Preferences) and remove
    DJANGO_SUPERUSER_PASSWORD from $APP/.env.
  • The certificate is self-signed. Settings → Updates → Site certificate
    gets a real one (Let's Encrypt in one click) or takes an uploaded pair.
  • Manage services as the service user:  sudo machinectl shell $SERVICE_USER@

EOF
