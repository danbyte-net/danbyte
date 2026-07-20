#!/usr/bin/env bash
# Danbyte one-shot installer — turns a fully-offline release bundle into a
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
# (postgresql, redis-server, nginx) still come from your distro — on an airgapped
# box, point apt at your local mirror first, or pre-install them.
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
while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --host=*) HOST="${1#*=}"; shift ;;
    --service-home) SERVICE_HOME="$2"; shift 2 ;;
    --no-nginx) DO_NGINX=0; shift ;;
    --unattended|-y) UNATTENDED=1; shift ;;
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
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root (sudo ./install.sh)"
[ -d "$BUNDLE/vendor/wheels" ] && [ -x "$BUNDLE/vendor/python/bin/python3" ] \
  || die "this doesn't look like an offline bundle (missing vendor/)."
[ -n "$HOST" ] || HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$HOST" ] || die "could not determine a host; pass --host <name-or-ip>"
ADMIN_LOGIN="$(logname 2>/dev/null || echo "${SUDO_USER:-}")"

# ── 1. OS services ───────────────────────────────────────────────────────────
# nginx is only needed when this installer manages the TLS front end; --no-nginx
# means you terminate TLS elsewhere (or run direct), so don't require it.
if [ "$DO_NGINX" -eq 1 ]; then
  step "OS packages (postgresql, redis-server, nginx)"
  PKGS="postgresql redis-server nginx"
  CHECK_BINS="psql redis-server nginx"
else
  step "OS packages (postgresql, redis-server) — skipping nginx (--no-nginx)"
  PKGS="postgresql redis-server"
  CHECK_BINS="psql redis-server"
fi
need_pkg=0
for b in $CHECK_BINS; do command -v "$b" >/dev/null 2>&1 || need_pkg=1; done
if [ "$need_pkg" -eq 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y $PKGS \
      || die "apt could not install $PKGS — install them, then re-run."
  else
    die "$PKGS missing and apt-get not found — pre-install them."
  fi
fi
systemctl enable --now postgresql redis-server >/dev/null 2>&1 || true

# ── 2. Node runtime (bundled → /usr/bin/node if the host's is missing/too old) ─
# rolldown-vite's native binding is engine-gated to Node ≥ 20.19; a stale system
# node makes `vite preview` (the frontend unit) crash at boot. So don't accept
# just any existing node — install the bundled runtime whenever the host's is
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
# `node` resolves to on PATH — a new node at /usr/local/bin won't help a unit
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
    echo "  $NODE_BIN ($("$NODE_BIN" -v 2>/dev/null || echo unknown)) is below the ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR} floor — installing bundled node"
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

# Log directory — the app (running as the service user) writes danbyte.log +
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
  # that predate it — a fresh random key; existing secrets were encrypted under
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
# Do NOT change once credentials are stored — old ciphertext becomes unreadable.
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
  && .venv/bin/python manage.py collectstatic --noinput >/dev/null"

# ── 9. systemd units ─────────────────────────────────────────────────────────
step "Installing + (re)starting services"
as_user bash -lc "cd '$APP' && make install-services install-prod-services >/dev/null"
DANBYTE_UNITS="danbyte-web danbyte-ws danbyte-frontend-prod danbyte-workers danbyte-docs"
# enable = start at boot; restart = pick up freshly-deployed code (a plain
# `enable --now` is a no-op on already-running units, so a re-install/upgrade
# would keep serving the OLD code — restart is what makes the update take).
as_user systemctl --user enable $DANBYTE_UNITS >/dev/null 2>&1 || true
as_user systemctl --user restart $DANBYTE_UNITS

# ── 10. nginx + TLS ──────────────────────────────────────────────────────────
if [ "$DO_NGINX" -eq 1 ]; then
  step "nginx + TLS (self-signed) for $HOST"
  ( cd "$APP" && make proxy-install \
      NGINX_TMPL=deploy/nginx/danbyte.prod.conf.template \
      PROXY_HOST="$HOST" >/dev/null )
fi

# ── Done ─────────────────────────────────────────────────────────────────────
if [ "$DO_NGINX" -eq 1 ]; then
  URL="https://$HOST/"
else
  # No managed terminator — the app serves plain HTTP on the frontend port.
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
  • For a public host, replace the self-signed cert with a real one (certbot).
  • Manage services as the service user:  sudo machinectl shell $SERVICE_USER@

EOF
