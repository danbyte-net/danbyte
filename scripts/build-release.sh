#!/usr/bin/env bash
# Build a FULLY OFFLINE Danbyte release bundle.
#
#   scripts/build-release.sh [VERSION]
#
# Produces  dist/danbyte-<version>-linux-x86_64.tar.gz  containing everything a
# fresh, internet-less Ubuntu/Debian box needs to run Danbyte:
#
#   <bundle>/                     clean source tree (git-tracked files)
#   <bundle>/frontend/dist        prebuilt SSR frontend
#   <bundle>/frontend/node_modules JS runtime deps (vite preview)
#   <bundle>/staticfiles          collected Django/DRF static
#   <bundle>/vendor/wheels        every Python dep as a binary wheel (wheelhouse)
#   <bundle>/vendor/python        standalone CPython 3.13 (relocatable)
#   <bundle>/vendor/node          Node runtime (matches the ABI node_modules was built with)
#   <bundle>/install.sh           the one-shot installer (scripts/install.sh)
#   <bundle>/BUNDLE_INFO          version / platform / build date
#
# This script needs the internet (it runs in CI); the *bundle* it produces does
# not. Run from a checkout with the version you want committed.
set -euo pipefail

# ── Pinned runtimes ──────────────────────────────────────────────────────────
# rolldown-vite needs Node ≥ 20.19 (its native binding is an engine-gated
# optional dep npm silently skips on older Node). Match the dev machine (22.x).
NODE_VERSION="${NODE_VERSION:-22.22.1}"
# python-build-standalone "install_only" (relocatable). Bump the date+version
# together; the asset name must exist under that release tag.
PBS_TAG="${PBS_TAG:-20260623}"
PBS_PYTHON="${PBS_PYTHON:-3.13.14}"
PLATFORM="linux-x86_64"

# Pinned SHA-256 of each downloaded runtime archive — an upstream/mirror swap or
# a MITM can't slip modified code into the bundle. Bump these in lockstep with
# NODE_VERSION / PBS_TAG+PBS_PYTHON above (node: nodejs.org/dist/vX/SHASUMS256.txt;
# PBS: the release's SHA256SUMS asset).
NODE_SHA256="${NODE_SHA256:-9a6bc82f9b491279147219f6a18add1e18424dce90d41d2a5fcd69d4924ba3aa}"
PBS_SHA256="${PBS_SHA256:-7fd02919461b368adafea3896ad082f5c4f759816d69681dcc6559bfbcd892af}"

# Download to a file and verify its pinned SHA-256 before use (no `curl | tar`,
# which would extract unverified bytes). Args: url expected-sha256 dest-file.
fetch_verified() {
  local url="$1" want="$2" dest="$3"
  curl -fsSL "$url" -o "$dest"
  echo "${want}  ${dest}" | sha256sum -c - \
    || { echo "checksum mismatch for $url" >&2; exit 1; }
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="${1:-$(python3 -c 'import re,pathlib; print(re.search(r"__version__\s*=\s*\"([^\"]+)\"", pathlib.Path("danbyte/__init__.py").read_text()).group(1))')}"
NAME="danbyte-${VERSION}-${PLATFORM}"
OUT="$ROOT/dist"
STAGE="$(mktemp -d)/${NAME}"
mkdir -p "$STAGE" "$OUT"

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

# ── 1. Clean source (git-tracked files only — no .venv/node_modules/dist) ─────
log "Exporting source tree @ ${VERSION}"
git archive --format=tar HEAD | tar -x -C "$STAGE"

# ── 2. Bundled Node runtime (install first so node_modules matches its ABI) ───
log "Fetching Node ${NODE_VERSION}"
mkdir -p "$STAGE/vendor"
fetch_verified \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
  "$NODE_SHA256" "$STAGE/node.tar.xz"
tar -xJ -C "$STAGE" -f "$STAGE/node.tar.xz"
rm -f "$STAGE/node.tar.xz"
mv "$STAGE/node-v${NODE_VERSION}-linux-x64" "$STAGE/vendor/node"
export PATH="$STAGE/vendor/node/bin:$PATH"

# ── 3. Frontend: build with the bundled node, keep node_modules for runtime ───
log "Building frontend (node $(node -v))"
( cd "$STAGE/frontend" && npm ci --no-audit --no-fund && npm run build )

# ── 4. Standalone CPython 3.13 (relocatable base for the target venv) ─────────
log "Fetching standalone CPython ${PBS_PYTHON}"
fetch_verified \
  "https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/cpython-${PBS_PYTHON}+${PBS_TAG}-x86_64-unknown-linux-gnu-install_only.tar.gz" \
  "$PBS_SHA256" "$STAGE/cpython.tar.gz"
tar -xz -C "$STAGE/vendor" -f "$STAGE/cpython.tar.gz"   # extracts to $STAGE/vendor/python
rm -f "$STAGE/cpython.tar.gz"
PYBIN="$STAGE/vendor/python/bin/python3"

# ── 5. Wheelhouse: every dep as a binary wheel, built once here ───────────────
# Built with the bundled python so wheels match the runtime; libldap2-dev must be
# present in CI for python-ldap to compile its wheel.
log "Building wheelhouse"
"$PYBIN" -m pip install --upgrade pip wheel >/dev/null
"$PYBIN" -m pip wheel -r "$STAGE/requirements.txt" -w "$STAGE/vendor/wheels"

# ── 6. collectstatic (offline — validates the wheelhouse too) ─────────────────
log "Collecting static"
BUILD_VENV="$(mktemp -d)/venv"
"$PYBIN" -m venv "$BUILD_VENV"
"$BUILD_VENV/bin/pip" install --no-index --find-links "$STAGE/vendor/wheels" -r "$STAGE/requirements.txt" >/dev/null
( cd "$STAGE" && DJANGO_SECRET_KEY=build-only DEBUG=True \
    "$BUILD_VENV/bin/python" manage.py collectstatic --noinput >/dev/null )

# ── 7. Installer + metadata ──────────────────────────────────────────────────
cp "$STAGE/scripts/install.sh" "$STAGE/install.sh"
chmod +x "$STAGE/install.sh"
cat > "$STAGE/BUNDLE_INFO" <<EOF
danbyte $VERSION
platform: $PLATFORM
node: $NODE_VERSION
python: $PBS_PYTHON ($PBS_TAG)
offline: yes (wheels + node_modules + node + python bundled)
EOF

# ── 8. Tarball ───────────────────────────────────────────────────────────────
log "Packing ${NAME}.tar.gz"
tar -czf "$OUT/${NAME}.tar.gz" -C "$(dirname "$STAGE")" "$NAME"
( cd "$OUT" && sha256sum "${NAME}.tar.gz" > "${NAME}.tar.gz.sha256" )
rm -rf "$(dirname "$STAGE")" "$(dirname "$BUILD_VENV")"

log "Done → dist/${NAME}.tar.gz"
du -h "$OUT/${NAME}.tar.gz"
