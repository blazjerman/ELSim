#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGSPICE_SOURCE="${NGSPICE_SOURCE:-}"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build/ngspice-wasm}"
JOBS="${JOBS:-2}"
PINNED_COMMIT="$(tr -d '[:space:]' < "$ROOT_DIR/engine/wasm/UPSTREAM_COMMIT")"

if [[ -z "$NGSPICE_SOURCE" || ! -d "$NGSPICE_SOURCE/.git" ]]; then
  echo "Set NGSPICE_SOURCE to a Git checkout of ngspice $PINNED_COMMIT" >&2
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
if [[ ! -f "$NGSPICE_SOURCE/configure" ]]; then
  if [[ ! -x "$NGSPICE_SOURCE/autogen.sh" ]]; then
    echo "Pinned ngspice Git checkout has neither configure nor executable autogen.sh" >&2
    exit 2
  fi
  echo "Bootstrapping configure from the pinned ngspice Git source"
  (cd "$NGSPICE_SOURCE" && ./autogen.sh)
fi
if [[ ! -f "$NGSPICE_SOURCE/configure" ]]; then
  echo "ngspice autogen.sh completed without generating configure" >&2
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

# The static artifacts do not include optional XSPICE Verilog/VHDL shared
# adapters. The table code model is GPL-2.0-or-later, so omit it from the
# browser build rather than linking it into this mixed-license application.
python3 "$ROOT_DIR/tools/configure-ngspice-xspice-subdirs.py" \
  "$BUILD_DIR/src/xspice/Makefile"

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
git -C "$NGSPICE_SOURCE" archive --format=tar "$PINNED_COMMIT" | gzip -n > "$ROOT_DIR/public/engine/ngspice-source.tar.gz"
mapfile -t RELINK_OBJECTS < <(find "$BUILD_DIR" -type f \( -name '*.o' -o -name '*.a' \) -printf '%P\n' | sort)
if [[ ${#RELINK_OBJECTS[@]} -eq 0 ]]; then
  echo "Expected compiled object or archive files for LGPL relinking materials" >&2
  exit 2
fi
tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - -C "$BUILD_DIR" "${RELINK_OBJECTS[@]}" | gzip -n > "$ROOT_DIR/public/engine/ngspice-relink-objects.tar.gz"
LINK_MAP="$(find "$BUILD_DIR" -type f -name ngspice-link.map -print -quit)"
if [[ -z "$LINK_MAP" || ! -s "$LINK_MAP" ]]; then
  echo "Expected a non-empty Emscripten linker map under $BUILD_DIR; refusing to emit an incomplete engine inventory" >&2
  exit 2
fi
cp "$LINK_MAP" "$ROOT_DIR/public/engine/ngspice-link.map"
tar -tzf "$ROOT_DIR/public/engine/ngspice-source.tar.gz" > "$BUILD_DIR/ngspice-source-paths.txt"
node "$ROOT_DIR/tools/inventory-ngspice-link-map.mjs" \
  "$ROOT_DIR/public/engine/ngspice-link.map" \
  "$BUILD_DIR/ngspice-source-paths.txt" \
  "$ROOT_DIR/public/engine/ngspice-linked-object-inventory.json"
{
  printf 'ngspice source commit: %s\n' "$PINNED_COMMIT"
  printf 'Emscripten: %s\n' "$(emcc --version | head -n 1)"
  printf 'Build flags: --disable-shared --enable-static --enable-xspice --disable-cider --disable-osdi --disable-openmp --disable-klu --with-readline=no --with-editline=no --without-x\n'
  printf 'Linked-input inventory: ngspice-link.map plus ngspice-linked-object-inventory.json (candidate source paths require per-file license review; generated inventory is not a legal determination)\n'
  printf 'Redistribution: check licenses/ngspice-distribution-review.json; do not distribute unless it approves these exact generated artifacts and source materials.\n'
  printf 'Source commit: %s (must match the approved review record)\n' "$PINNED_COMMIT"
  printf 'Source materials: ngspice-source.tar.gz and ngspice-relink-objects.tar.gz.\n'
  printf 'See adjacent THIRD_PARTY_NOTICES.md, ngspice-COPYING.txt, ngspice-link.map, ngspice-linked-object-inventory.json, and ngspice-SHA256SUMS.txt.\n'
} > "$ROOT_DIR/public/engine/ngspice-build-info.txt"
(cd "$ROOT_DIR/public/engine" && sha256sum ngspice.mjs ngspice.wasm ngspice-COPYING.txt ngspice-link.map ngspice-linked-object-inventory.json THIRD_PARTY_NOTICES.md ngspice-source.tar.gz ngspice-relink-objects.tar.gz ngspice-build-info.txt > ngspice-SHA256SUMS.txt)
cat "$ROOT_DIR/public/engine/ngspice-SHA256SUMS.txt"
du -h "$ROOT_DIR/public/engine/ngspice.mjs" "$ROOT_DIR/public/engine/ngspice.wasm" "$ROOT_DIR/public/engine/ngspice-source.tar.gz" "$ROOT_DIR/public/engine/ngspice-relink-objects.tar.gz" "$ROOT_DIR/public/engine/ngspice-COPYING.txt"
