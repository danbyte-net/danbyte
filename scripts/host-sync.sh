#!/usr/bin/env bash
# The root half of an install or upgrade: what the app's user cannot do.
#
#   host-sync.sh --app DIR --user USER [--host NAME] [--fresh] [--old-template FILE]
#                [--log-dir DIR] [--no-nginx] [--adopt]
#
# Run as root from a tree root owns - the unpacked bundle, from install.sh -
# or, with `sudo make host-sync`, from the app's own tree (the administrator's
# choice: that tree belongs to the app's user). It renders files from the
# tree it lives in and never runs anything from the app directory:
#
#   * logrotate for the log directory;
#   * the site-certificate unit, with its apply script as a root-owned copy;
#   * the nginx site: a fresh install gets a self-signed certificate and a new
#     site. An existing site is re-rendered only while it is still exactly
#     what Danbyte rendered (a stored hash, or --old-template rendered the
#     same way) - with the certificate paths, server_name, mode and owner it
#     has now - and the previous file comes back if `nginx -t` refuses the
#     new one. A site edited by hand is left alone; the new render is written
#     beside it as danbyte.conf.new (--adopt replaces it anyway, keeping a
#     backup).
set -euo pipefail

TREE="$(cd "$(dirname "$0")/.." && pwd)"
# Tests put the host's files under a scratch root; empty on a real host.
R="${DANBYTE_HOST_ROOT:-}"
APP="" SVC_USER="" HOST="" FRESH=0 OLD_TEMPLATE="" LOG_DIR="/var/log/danbyte" NGINX=1 ADOPT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --fresh) FRESH=1; shift ;;
    --old-template) OLD_TEMPLATE="$2"; shift 2 ;;
    --log-dir) LOG_DIR="$2"; shift 2 ;;
    --no-nginx) NGINX=0; shift ;;
    --adopt) ADOPT=1; shift ;;
    *) echo "host-sync: unknown option $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "host-sync: run as root" >&2; exit 1; }
[ -n "$APP" ] && [ -n "$SVC_USER" ] || { echo "host-sync: --app and --user are required" >&2; exit 2; }
id -u "$SVC_USER" >/dev/null 2>&1 || { echo "host-sync: no user $SVC_USER" >&2; exit 1; }

SITE="$R/etc/nginx/sites-available/danbyte.conf"
HASH_DIR="$R/etc/danbyte"
HASH_FILE="$HASH_DIR/nginx-site.sha256"
LIBEXEC="$R/usr/local/libexec/danbyte"
UNIT_DIR="$R/etc/systemd/system"
CERT_DEFAULT=/etc/ssl/danbyte/danbyte.crt
KEY_DEFAULT=/etc/ssl/danbyte/danbyte.key
NOTES=()
say() { printf '  %s\n' "$*"; }
note() { NOTES+=("$*"); }
as_user() { runuser -u "$SVC_USER" -- "$@"; }

# ── logrotate ────────────────────────────────────────────────────────────────
if [ -d "$R/etc/logrotate.d" ]; then
  sed -e "s#@@LOG_DIR@@#$LOG_DIR#g" -e "s#@@USER@@#$SVC_USER#g" \
    "$TREE/deploy/logrotate/danbyte" >"$R/etc/logrotate.d/danbyte.tmp"
  chmod 644 "$R/etc/logrotate.d/danbyte.tmp"
  mv -f "$R/etc/logrotate.d/danbyte.tmp" "$R/etc/logrotate.d/danbyte"
  say "logrotate: /etc/logrotate.d/danbyte"
fi

[ "$NGINX" -eq 1 ] || { say "nginx: skipped (--no-nginx)"; exit 0; }
command -v nginx >/dev/null 2>&1 || { echo "host-sync: nginx is not installed" >&2; exit 1; }

# ── the site-certificate unit ────────────────────────────────────────────────
# The folder the app drops a pair into is made by the app's user: root never
# creates, chowns or chmods inside the app's tree.
as_user mkdir -p "$APP/deploy/nginx/certs"
as_user chmod 750 "$APP/deploy/nginx/certs"
install -d -o root -g root -m 755 "$LIBEXEC" "$R/var/lib/danbyte-tls"
install -o root -g root -m 755 "$TREE/scripts/danbyte-tls-apply.sh" "$LIBEXEC/danbyte-tls-apply.sh"
for u in path service; do
  sed -e "s|@@APP@@|$APP|g" -e "s|@@USER@@|$SVC_USER|g" \
    "$TREE/deploy/systemd/danbyte-tls.$u.template" >"$UNIT_DIR/danbyte-tls.$u"
  chmod 644 "$UNIT_DIR/danbyte-tls.$u"
done
systemctl daemon-reload
systemctl enable --now danbyte-tls.path >/dev/null 2>&1 || note "danbyte-tls.path did not start"
say "site certificate: danbyte-tls.path runs /usr/local/libexec/danbyte/danbyte-tls-apply.sh"

# ── nginx ────────────────────────────────────────────────────────────────────
# render <template> <server_name> <cert> <key> > file
render() {
  local ver h2l h2d
  ver=$(nginx -v 2>&1 | sed -n 's|.*/\([0-9][0-9.]*\).*|\1|p')
  if [ -n "$ver" ] && [ "$(printf '1.25.1\n%s\n' "$ver" | sort -V | head -n1)" = "1.25.1" ]; then
    h2l=""; h2d="    http2 on;"
  else
    h2l=" http2"; h2d=""
  fi
  sed -e "s|@@SERVER_NAME@@|$2|g" -e "s|@@CERT@@|$3|g" -e "s|@@KEY@@|$4|g" \
      -e "s|@@STATIC_ROOT@@|$APP/staticfiles|g" -e "s|@@MEDIA_ROOT@@|$APP/media|g" \
      -e "s|@@MAINTENANCE_ROOT@@|$APP/deploy|g" \
      -e "s|@@H2_LISTEN@@|$h2l|g" -e "s|@@H2_DIRECTIVE@@|$h2d|g" "$1"
}
site_value() {  # <directive>: its first value in the live site file
  sed -n "s/^[[:space:]]*$1[[:space:]]\\+\\([^;]*\\);.*/\\1/p" "$SITE" | head -n 1
}
store_hash() { install -d -m 755 "$HASH_DIR"; sha256sum "$SITE" | cut -d' ' -f1 >"$HASH_FILE"; }
# A render that may take the live site's place gets its mode and owner: a
# site from proxy-install is 0600, and root's umask would make it 0644.
keep_mode() {  # <render> - when there is a live site
  [ -e "$SITE" ] || return 0
  if ! { chmod --reference="$SITE" "$1" && chown --reference="$SITE" "$1"; }; then
    note "$1 could not take the mode and owner of $SITE"
  fi
}

TEMPLATE="$TREE/deploy/nginx/danbyte.prod.conf.template"
if [ "$FRESH" -eq 1 ] || [ ! -f "$SITE" ]; then
  [ -n "$HOST" ] || HOST="$(hostname -I 2>/dev/null | awk '{print $1}')"
  if [ ! -s "$R$CERT_DEFAULT" ] || [ ! -s "$R$KEY_DEFAULT" ]; then
    install -d -m 755 "$R/etc/ssl/danbyte"
    if printf '%s' "$HOST" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
      san="IP:$HOST,DNS:localhost"
    else
      san="DNS:$HOST,DNS:localhost"
    fi
    ( umask 077
      openssl req -x509 -nodes -newkey rsa:2048 -days 825 -keyout "$R$KEY_DEFAULT" \
        -out "$R$CERT_DEFAULT" -subj "/CN=$HOST" -addext "subjectAltName=$san" 2>/dev/null )
    chmod 644 "$R$CERT_DEFAULT"
    chmod 600 "$R$KEY_DEFAULT"
    # The app shows and replaces the pair it can see in its drop folder.
    as_user tee "$APP/deploy/nginx/certs/danbyte.crt" <"$R$CERT_DEFAULT" >/dev/null
    say "self-signed certificate for $HOST"
  fi
  render "$TEMPLATE" "$HOST" "$CERT_DEFAULT" "$KEY_DEFAULT" >"$SITE.tmp"
  keep_mode "$SITE.tmp"
  mv -f "$SITE.tmp" "$SITE"
  mkdir -p "$R/etc/nginx/sites-enabled"
  ln -sfn "$SITE" "$R/etc/nginx/sites-enabled/danbyte.conf"
  rm -f "$R/etc/nginx/sites-enabled/default"
  nginx -t
  systemctl enable --now nginx >/dev/null 2>&1
  systemctl reload nginx
  store_hash
  say "nginx: $SITE for $HOST"
else
  live_host="$(site_value server_name)"
  live_crt="$(site_value ssl_certificate)"
  live_key="$(site_value ssl_certificate_key)"
  [ -n "$HOST" ] || HOST="$live_host"
  pristine=$ADOPT
  if [ "$pristine" -eq 1 ]; then
    :
  elif [ -f "$HASH_FILE" ]; then
    [ "$(sha256sum "$SITE" | cut -d' ' -f1)" = "$(cat "$HASH_FILE")" ] && pristine=1
  elif [ -n "$OLD_TEMPLATE" ] && [ -f "$OLD_TEMPLATE" ]; then
    # No stored hash (a site rendered before 0.17): the site is untouched
    # when the previous release's template renders to exactly it.
    render "$OLD_TEMPLATE" "$live_host" "$live_crt" "$live_key" | cmp -s - "$SITE" && pristine=1
  fi
  render "$TEMPLATE" "${HOST:-$live_host}" "${live_crt:-$CERT_DEFAULT}" "${live_key:-$KEY_DEFAULT}" >"$SITE.new"
  keep_mode "$SITE.new"
  if cmp -s "$SITE.new" "$SITE"; then
    rm -f "$SITE.new"
    store_hash
    say "nginx: $SITE is current"
  elif [ "$pristine" -eq 1 ]; then
    backup="$SITE.bak-$(date +%Y%m%d%H%M%S)"
    cp -p "$SITE" "$backup"
    mv -f "$SITE.new" "$SITE"
    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      store_hash
      say "nginx: $SITE re-rendered (previous kept as $backup)"
    else
      cp -p "$backup" "$SITE"
      nginx -t >/dev/null 2>&1 && systemctl reload nginx
      note "nginx refused the new site; the previous one is back ($backup). Check: nginx -t"
    fi
  else
    note "$SITE was changed by hand (or rendered before 0.17), so it was left alone. The new render is $SITE.new - merge it, then: nginx -t && systemctl reload nginx. To take the new one as it is: host-sync with --adopt (make host-sync ADOPT=1)"
  fi
fi

for n in "${NOTES[@]}"; do printf '\033[1;33m! %s\033[0m\n' "$n" >&2; done
exit 0
