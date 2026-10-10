#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGSPICE_SOURCE="${NGSPICE_SOURCE:-}"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build/ngspice-wasm}"
JOBS="${JOBS:-2}"
PINNED_COMMIT="$(tr -d '[:space:]' < "$ROOT_DIR/engine/wasm/UPSTREAM_COMMIT")"

if [[ -z "$NGSPICE_SOURCE" || ! -f "$NGSPICE_SOURCE/configure" ]]; then
  echo "Set NGSPICE_SOURCE to a checkout of ngspice $PINNED_COMMIT" >&2
  exit 2
fi
actual_commit="$(git -C "$NGSPICE_SOURCE" rev-parse HEAD)"
if [[ "$actual_commit" != "$PINNED_COMMIT" ]]; then
  echo "Expected ngspice $PINNED_COMMIT, got $actual_commit" >&2
  exit 2
fi
if [[ -n "$(git -C "$NGSPICE_SOURCE" status --porcelain)" ]]; then
  echo "NGSPICE_SOURCE must be clean; local source changes make the binary unreviewable" >&2
  exit 2
fi
if [[ ! -f "$NGSPICE_SOURCE/COPYING" ]]; then
  echo "Pinned ngspice source must include its COPYING file" >&2
  exit 2
fi
if ! emcc --version | head -n 1 | grep -q '5\.0\.7'; then
  echo "This tested build recipe requires Emscripten 5.0.7 on PATH" >&2
  exit 2
fi

mkdir -p "$BUILD_DIR"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
cd "$BUILD_DIR"
"$NGSPICE_SOURCE/configure" \
  --build="$(gcc -dumpmachine)" \
  --host=wasm32-unknown-emscripten \
  --disable-dependency-tracking \
  --disable-shared \
  --enable-static \
  --enable-xspice \
  --disable-cider \
  --disable-osdi \
  --disable-openmp \
  --disable-klu \
  --with-readline=no \
  --with-editline=no \
  --disable-debug \
  --without-x \
  ac_cv_exeext=.js \
  CFLAGS=-O2 \
  "LDFLAGS=-O2 -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createNgspiceModule -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sSTACK_SIZE=2097152 -sEXPORTED_FUNCTIONS=_main -sEXPORTED_RUNTIME_METHODS=FS,callMain -Wl,--allow-multiple-definition -Wl,-Map,ngspice-link.map" \
  build_alias="$(gcc -dumpmachine)" \
  host_alias=wasm32-unknown-emscripten \
  CC="$(command -v emcc)" \
  CXX="$(command -v em++)"

# Emscripten cannot produce the optional XSPICE Verilog and VHDL shared modules.
# This build does not package or validate XSPICE .cm model modules.
python3 - "$BUILD_DIR/src/xspice/Makefile" <<'PY'
from pathlib import Path
import sys

makefile = Path(sys.argv[1])
text = makefile.read_text()
old = "SUBDIRS = mif cm enh evt idn cmpp icm verilog vhdl"
new = "SUBDIRS = mif cm enh evt idn cmpp icm"
if text.count(old) != 1:
    raise SystemExit(f"Unexpected generated XSPICE subdirectory list in {makefile}")
makefile.write_text(text.replace(old, new))
PY

# Make sure the link map describes the binary emitted by this invocation, not a
# previous link left in a reused build directory.
make clean
find "$BUILD_DIR" -type f -name ngspice-link.map -delete
make -j"$JOBS"
mkdir -p "$ROOT_DIR/public/engine"
cp "$BUILD_DIR/src/ngspice.js" "$ROOT_DIR/public/engine/ngspice.mjs"
cp "$BUILD_DIR/src/ngspice.wasm" "$ROOT_DIR/public/engine/ngspice.wasm"
cp "$NGSPICE_SOURCE/COPYING" "$ROOT_DIR/public/engine/ngspice-COPYING.txt"
cp "$ROOT_DIR/THIRD_PARTY_NOTICES.md" "$ROOT_DIR/public/engine/THIRD_PARTY_NOTICES.md"
LINK_MAP="$(find "$BUILD_DIR" -type f -name ngspice-link.map -print -quit)"
if [[ -z "$LINK_MAP" || ! -s "$LINK_MAP" ]]; then
  echo "Expected a non-empty Emscripten linker map under $BUILD_DIR; refusing to emit an incomplete engine inventory" >&2
  exit 2
fi
cp "$LINK_MAP" "$ROOT_DIR/public/engine/ngspice-link.map"
{
  printf 'ngspice source commit: %s\n' "$PINNED_COMMIT"
  printf 'Emscripten: %s\n' "$(emcc --version | head -n 1)"
  printf 'Build flags: --disable-shared --enable-static --enable-xspice --disable-cider --disable-osdi --disable-openmp --disable-klu --with-readline=no --with-editline=no --without-x\n'
  printf 'Linked-input inventory: ngspice-link.map (Emscripten linker map; inspect archive members and object paths against the pinned source COPYING file)\n'
  printf 'License review: incomplete; generated browser artifacts are not cleared for redistribution.\n'
  printf 'See adjacent THIRD_PARTY_NOTICES.md, ngspice-COPYING.txt, ngspice-link.map, and ngspice-SHA256SUMS.txt.\n'
} > "$ROOT_DIR/public/engine/ngspice-build-info.txt"
sha256sum "$ROOT_DIR/public/engine/ngspice.mjs" "$ROOT_DIR/public/engine/ngspice.wasm" "$ROOT_DIR/public/engine/ngspice-COPYING.txt" "$ROOT_DIR/public/engine/ngspice-link.map" > "$ROOT_DIR/public/engine/ngspice-SHA256SUMS.txt"
cat "$ROOT_DIR/public/engine/ngspice-SHA256SUMS.txt"
du -h "$ROOT_DIR/public/engine/ngspice.mjs" "$ROOT_DIR/public/engine/ngspice.wasm" "$ROOT_DIR/public/engine/ngspice-COPYING.txt"
