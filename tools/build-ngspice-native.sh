#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NGSPICE_SOURCE="${NGSPICE_SOURCE:-}"
BUILD_DIR="${BUILD_DIR:-$ROOT_DIR/build/ngspice-native}"
JOBS="${JOBS:-2}"
PINNED_COMMIT="$(tr -d '[:space:]' < "$ROOT_DIR/engine/wasm/UPSTREAM_COMMIT")"

if [[ ! "$JOBS" =~ ^[1-9][0-9]*$ ]]; then
  echo "JOBS must be a positive integer, got: $JOBS" >&2
  exit 2
fi

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
  echo "NGSPICE_SOURCE must be clean; local source changes make parity results ambiguous" >&2
  exit 2
fi

mkdir -p "$BUILD_DIR"
BUILD_DIR="$(cd "$BUILD_DIR" && pwd)"
SOURCE_DIR="$BUILD_DIR/source"
NATIVE_BUILD_DIR="$BUILD_DIR/build"
OUTPUT_DIR="$BUILD_DIR/bin"
# This directory is dedicated to generated native-build files. Recreate only
# its extracted source tree so configure/make state can be reused between runs.
rm -rf "$SOURCE_DIR"
mkdir -p "$SOURCE_DIR" "$NATIVE_BUILD_DIR" "$OUTPUT_DIR"
git -C "$NGSPICE_SOURCE" archive "$PINNED_COMMIT" | tar -x -C "$SOURCE_DIR"

if [[ ! -f "$SOURCE_DIR/configure" ]]; then
  if [[ ! -x "$SOURCE_DIR/autogen.sh" ]]; then
    echo "Pinned ngspice source has neither configure nor executable autogen.sh" >&2
    exit 2
  fi
  (cd "$SOURCE_DIR" && ./autogen.sh)
fi
if [[ ! -f "$SOURCE_DIR/configure" ]]; then
  echo "ngspice autogen.sh completed without generating configure" >&2
  exit 2
fi

cd "$NATIVE_BUILD_DIR"
"$SOURCE_DIR/configure" \
  --disable-dependency-tracking \
  --disable-shared \
  --enable-static \
  --disable-cider \
  --disable-osdi \
  --disable-openmp \
  --disable-klu \
  --with-readline=no \
  --with-editline=no \
  --disable-debug \
  --without-x \
  CFLAGS=-O2
make -j"$JOBS"

BUILT_EXECUTABLE="$NATIVE_BUILD_DIR/src/ngspice"
if [[ ! -x "$BUILT_EXECUTABLE" ]]; then
  echo "Expected native ngspice executable at $BUILT_EXECUTABLE" >&2
  exit 2
fi
cp "$BUILT_EXECUTABLE" "$OUTPUT_DIR/ngspice"
printf '%s\n' "$PINNED_COMMIT" > "$OUTPUT_DIR/ngspice.source-commit"
"$OUTPUT_DIR/ngspice" --version
echo "Native parity executable: $OUTPUT_DIR/ngspice"
echo "Source commit: $PINNED_COMMIT"
echo "Run: NGSPICE_NATIVE=$OUTPUT_DIR/ngspice npm run test:wasm:parity"
