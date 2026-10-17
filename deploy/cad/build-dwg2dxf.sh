#!/bin/sh
# LibreDWG's dwg2dxf, the DWG converter for floor-plan drawings, built from
# the pinned GNU release and linked statically, so one binary runs on any
# x86_64 Linux whatever its C library. The one recipe for every way Danbyte
# ships it:
#
#   - the container image: Dockerfile stage `cad-tools` (Alpine, musl)
#   - the release bundle: build-release.sh exports that same stage into
#     vendor/cad (Dockerfile target `cad-dist`)
#   - a source checkout: `make cad-tools`, with the host's compiler
#
#   deploy/cad/build-dwg2dxf.sh OUTDIR
#   deploy/cad/build-dwg2dxf.sh --version | --sha256
#
# OUTDIR gets:
#   bin/dwg2dxf               the program, static and stripped, mode 0755
#   LICENSE.libredwg          LibreDWG's licence (GPLv3)
#   NOTICE                    what it is and where its source is
#   src/libredwg-<v>.tar.xz   the exact source it was built from
#
# Needs a C toolchain, make, curl, xz, file and the internet, or
# LIBREDWG_TARBALL=<path> for an offline build (the checksum still has to
# match). Danbyte runs dwg2dxf as a separate program (api/cad_render.py) and
# does not link it.
set -eu

# Bump both together. The hash is that of the tarball whose GPG signature
# by the LibreDWG maintainer was checked when pinning.
LIBREDWG_VERSION=0.14
LIBREDWG_SHA256=62ebb73b984f865960f20ed26619ea5f8789d5e3fd088fa40a2598384da81275
# Any GNU mirror; the checksum still has to match.
GNU_MIRROR="${GNU_MIRROR:-https://ftp.gnu.org/gnu}"

case "${1:-}" in
  --version) echo "$LIBREDWG_VERSION"; exit 0 ;;
  --sha256) echo "$LIBREDWG_SHA256"; exit 0 ;;
  ""|-*) echo "usage: $0 OUTDIR" >&2; exit 2 ;;
esac

for tool in cc make pkg-config curl xz file sha256sum strip; do
  command -v "$tool" >/dev/null 2>&1 || { echo "build-dwg2dxf: $tool is missing" >&2; exit 1; }
done

mkdir -p "$1"
OUT=$(cd "$1" && pwd)
TARBALL="libredwg-$LIBREDWG_VERSION.tar.xz"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/libredwg.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
trap 'exit 130' INT TERM

if [ -n "${LIBREDWG_TARBALL:-}" ]; then
  cp "$LIBREDWG_TARBALL" "$WORK/$TARBALL"
else
  curl -fsSL -o "$WORK/$TARBALL" "$GNU_MIRROR/libredwg/$TARBALL"
fi
(cd "$WORK" && echo "$LIBREDWG_SHA256  $TARBALL" | sha256sum -c - >/dev/null) \
  || { echo "build-dwg2dxf: checksum mismatch for $TARBALL" >&2; exit 1; }

mkdir "$WORK/src"
xz -dc "$WORK/$TARBALL" | tar -xf - -C "$WORK/src"
cd "$WORK/src/libredwg-$LIBREDWG_VERSION"

# The library alone, static; then dwg2dxf linked with -all-static, libtool's
# word for a fully static executable (plain -static only picks static
# libtool libraries and still links libc dynamically).
./configure --disable-shared --enable-static --disable-bindings --disable-python \
    --disable-docs --disable-werror >"$WORK/configure.log" 2>&1 \
  || { tail -n 40 "$WORK/configure.log" >&2; exit 1; }
JOBS=$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 2)
make -C src -j"$JOBS" >"$WORK/make.log" 2>&1 || { tail -n 40 "$WORK/make.log" >&2; exit 1; }
make -C programs dwg2dxf LDFLAGS=-all-static >>"$WORK/make.log" 2>&1 \
  || { tail -n 40 "$WORK/make.log" >&2; exit 1; }

BIN=programs/dwg2dxf
strip "$BIN"
DESC=$(file -b "$BIN")
case "$DESC" in
  *"statically linked"*|*"static-pie linked"*) ;;
  *) echo "build-dwg2dxf: dwg2dxf is not statically linked: $DESC" >&2; exit 1 ;;
esac
"./$BIN" --version >/dev/null

mkdir -p "$OUT/bin" "$OUT/src"
cp "$BIN" "$OUT/bin/dwg2dxf"
chmod 0755 "$OUT/bin/dwg2dxf"
cp COPYING "$OUT/LICENSE.libredwg"
cp "$WORK/$TARBALL" "$OUT/src/$TARBALL"
chmod 0644 "$OUT/LICENSE.libredwg" "$OUT/src/$TARBALL"
cat >"$OUT/NOTICE" <<EOF
bin/dwg2dxf is LibreDWG $LIBREDWG_VERSION's DWG-to-DXF converter, a GNU project,
licensed under the GNU General Public License version 3 or later
(LICENSE.libredwg). Danbyte runs it as a separate program to read DWG
floor-plan drawings; it is not linked into Danbyte.

It was built unmodified, statically linked, from:
  src/$TARBALL
  SHA-256 $LIBREDWG_SHA256
  https://ftp.gnu.org/gnu/libredwg/$TARBALL
Upstream: https://www.gnu.org/software/libredwg/
The build recipe is deploy/cad/build-dwg2dxf.sh in the Danbyte source.
EOF
chmod 0644 "$OUT/NOTICE"
echo "dwg2dxf (LibreDWG $LIBREDWG_VERSION, static) -> $OUT/bin/dwg2dxf"
