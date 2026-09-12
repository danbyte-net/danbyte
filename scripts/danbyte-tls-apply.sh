#!/usr/bin/env bash
# Put the certificate Danbyte dropped in front of nginx - as root, from the
# danbyte-tls.path unit, never from the app.
#
# The app (Settings → Updates → Site certificate) writes a pair into the
# folder it owns, deploy/nginx/certs/, then a stamp file danbyte.apply as its
# last write. This runs when the stamp appears: verifies the pair, keeps the
# live pair aside, installs the new one where the live nginx config reads
# from, runs nginx -t, reloads - and puts the old pair back if nginx says no.
# The outcome lands in danbyte.applied for the app to show. No shell string is
# ever built from file contents; the app's database is never touched.
set -u

APP="${DANBYTE_DIR:?DANBYTE_DIR must point at the Danbyte checkout}"
DROP="$APP/deploy/nginx/certs"
STAMP="$DROP/danbyte.apply"
RESULT="$DROP/danbyte.applied"
NEW_CRT="$DROP/danbyte.crt"
NEW_KEY="$DROP/danbyte.key"
OWNER="$(stat -c %U "$DROP" 2>/dev/null || echo root)"

finish() {  # <outcome> <detail>
  sha="$(sha256sum "$NEW_CRT" 2>/dev/null | cut -d' ' -f1)"
  esc="$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g' | tr -d '\n')"
  printf '{"outcome":"%s","detail":"%s","sha256":"%s","at":"%s"}\n' \
    "$1" "$esc" "$sha" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$RESULT.tmp"
  chown "$OWNER" "$RESULT.tmp" 2>/dev/null || true
  chmod 644 "$RESULT.tmp"
  mv -f "$RESULT.tmp" "$RESULT"
  rm -f "$STAMP"
  logger -t danbyte-tls "$1: $2"
  [ "$1" = applied ]
}

[ -f "$STAMP" ] || exit 0
[ -s "$NEW_CRT" ] && [ -s "$NEW_KEY" ] || { finish failed "no pair in $DROP"; exit 1; }

# Where nginx reads from - the live config, never a guess. Both paths.
conf="$(nginx -T 2>/dev/null)"
LIVE_CRT="$(printf '%s\n' "$conf" | sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\+\([^;]*\);.*/\1/p' | head -n1)"
LIVE_KEY="$(printf '%s\n' "$conf" | sed -n 's/^[[:space:]]*ssl_certificate_key[[:space:]]\+\([^;]*\);.*/\1/p' | head -n1)"
[ -n "$LIVE_CRT" ] && [ -n "$LIVE_KEY" ] || { finish failed "could not read ssl_certificate paths from nginx -T"; exit 1; }

# The pair must belong together and be in date; nginx would refuse a mismatch
# later, but with the old pair already replaced.
if ! openssl x509 -in "$NEW_CRT" -noout -checkend 0 >/dev/null 2>&1; then
  finish failed "the certificate is expired or unreadable"; exit 1
fi
cpub="$(openssl x509 -in "$NEW_CRT" -noout -pubkey 2>/dev/null | openssl pkey -pubin -outform DER 2>/dev/null | sha256sum)"
kpub="$(openssl pkey -in "$NEW_KEY" -pubout -outform DER -passin pass: 2>/dev/null | sha256sum)"
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

install_like "$NEW_CRT" "$LIVE_CRT" 644 || { rollback; finish failed "could not write $LIVE_CRT"; exit 1; }
install_like "$NEW_KEY" "$LIVE_KEY" 640 || { rollback; finish failed "could not write $LIVE_KEY"; exit 1; }
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
