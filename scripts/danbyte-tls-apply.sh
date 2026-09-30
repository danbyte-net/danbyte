#!/usr/bin/env bash
# Put the certificate Danbyte dropped in front of nginx - as root, from the
# danbyte-tls.path unit, never from the app.
#
# The app (Settings → Updates → Site certificate) writes a pair into the
# folder it owns, deploy/nginx/certs/, then a stamp file danbyte.apply as its
# last write. This runs when the stamp appears: verifies the pair, keeps the
# live pair aside, installs the new one where the live nginx config reads
# from, runs nginx -t, reloads - and puts the old pair back if nginx says no.
# The outcome lands in /var/lib/danbyte-tls/applied.json for the app to show.
# No shell string is ever built from file contents; the app's database is
# never touched.
#
# The unit runs a root-owned copy (/usr/local/libexec/danbyte/, put there by
# the installer or `make install-tls-unit`), never the file in the app tree:
# the app's user owns that tree. For the same reason nothing here writes into
# the drop folder or follows a link out of it: the folder is entered once,
# must belong to the app's user, and the pair is copied out without following
# links before anything reads it.
set -u

APP="${DANBYTE_DIR:?DANBYTE_DIR must point at the Danbyte checkout}"
DROP="${DANBYTE_TLS_DROP:-$APP/deploy/nginx/certs}"
OWNER="${DANBYTE_USER:-}"
STATE_DIR="${DANBYTE_TLS_STATE:-/var/lib/danbyte-tls}"
RESULT="$STATE_DIR/applied.json"
STAMP=danbyte.apply

W="$(mktemp -d /tmp/danbyte-tls.XXXXXX)" || exit 1
trap 'rm -rf "$W"' EXIT

finish() {  # <outcome> <detail>
  local sha esc
  sha="$(sha256sum "$W/crt" 2>/dev/null | cut -d' ' -f1)"
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n')"
  install -d -o root -g root -m 755 "$STATE_DIR"
  printf '{"outcome":"%s","detail":"%s","sha256":"%s","at":"%s"}\n' \
    "$1" "$esc" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$W/result"
  install -o root -g root -m 644 "$W/result" "$RESULT"
  # In the pinned folder: unlink never follows a link.
  rm -f "./$STAMP"
  logger -t danbyte-tls "$1: $2"
  [ "$1" = applied ]
}

# Enter the drop folder once and stay there: whatever the path resolves to
# must be a directory the app's user owns, not one of root's.
cd -P "$DROP" 2>/dev/null || exit 0
[ -n "$OWNER" ] || OWNER="$(stat -c %U "$APP" 2>/dev/null)"
if [ "$(stat -c %U .)" != "$OWNER" ] || [ "$(stat -c %u .)" = 0 ]; then
  logger -t danbyte-tls "refused: $DROP is not a folder of $OWNER"
  exit 1
fi
[ -e "./$STAMP" ] || exit 0
for f in danbyte.crt danbyte.key; do
  # -P copies a link as a link; only a regular file passes.
  if [ -L "./$f" ] || [ ! -f "./$f" ]; then
    finish failed "no usable $f in $DROP (missing, or not a plain file)"; exit 1
  fi
  cp -P "./$f" "$W/$f" 2>/dev/null
  if [ -L "$W/$f" ] || [ ! -f "$W/$f" ] || [ ! -s "$W/$f" ]; then
    finish failed "no usable $f in $DROP (missing, empty or a link)"; exit 1
  fi
done
mv "$W/danbyte.crt" "$W/crt"
mv "$W/danbyte.key" "$W/key"
chmod 600 "$W/key"

# Where nginx reads from - the live config, never a guess. Both paths.
conf="$(nginx -T 2>/dev/null)"
LIVE_CRT="$(printf '%s\n' "$conf" | sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\([^;]*\);.*/\1/p' | head -n1)"
LIVE_KEY="$(printf '%s\n' "$conf" | sed -n 's/^[[:space:]]*ssl_certificate_key[[:space:]]\+\([^;]*\);.*/\1/p' | head -n1)"
[ -n "$LIVE_CRT" ] && [ -n "$LIVE_KEY" ] || { finish failed "could not read ssl_certificate paths from nginx -T"; exit 1; }

# The pair must belong together and be in date; nginx would refuse a mismatch
# later, but with the old pair already replaced.
if ! openssl x509 -in "$W/crt" -noout -checkend 0 >/dev/null 2>&1; then
  finish failed "the certificate is expired or unreadable"; exit 1
fi
cpub="$(openssl x509 -in "$W/crt" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)"
kpub="$(openssl pkey -in "$W/key" -pubout -outform DER -passin pass: 2>/dev/null | sha256sum)"
[ -n "$cpub" ] && [ "$cpub" = "$kpub" ] || { finish failed "the key does not match the certificate"; exit 1; }

# Keep what is live in a root-only spot until nginx has accepted the new pair.
PREV="$(mktemp -d /etc/ssl/danbyte-previous.XXXXXX)" || { finish failed "mktemp failed"; exit 1; }
cp -a "$LIVE_CRT" "$PREV/crt" 2>/dev/null && cp -a "$LIVE_KEY" "$PREV/key" 2>/dev/null
had_prev=$?

install_like() {  # <src> <dest> <default mode>
  if [ -e "$2" ]; then
    install -o "$(stat -c %U "$2")" -g "$(stat -c %G "$2")" -m "$(stat -c %a "$2")" "$1" "$2"
  else
    install -o root -g root -m "$3" "$1" "$2"
  fi
}
rollback() {
  if [ "$had_prev" -eq 0 ]; then
    cp -a "$PREV/crt" "$LIVE_CRT"; cp -a "$PREV/key" "$LIVE_KEY"
  fi
  rm -rf "$PREV"
}

install_like "$W/crt" "$LIVE_CRT" 644 || { rollback; finish failed "could not write $LIVE_CRT"; exit 1; }
install_like "$W/key" "$LIVE_KEY" 640 || { rollback; finish failed "could not write $LIVE_KEY"; exit 1; }
if ! msg="$(nginx -t 2>&1)"; then
  rollback
  finish failed "nginx -t refused the pair - previous pair restored: $(printf '%s' "$msg" | tail -n 2)"
  exit 1
fi
rm -rf "$PREV"
if ! systemctl reload nginx 2>&1; then
  finish failed "the pair is installed and the config is valid, but nginx did not reload"; exit 1
fi
finish applied "installed $LIVE_CRT and reloaded nginx"
