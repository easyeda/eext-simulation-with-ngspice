#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

to_unix_path() {
  local value="$1"
  if command -v cygpath >/dev/null 2>&1 && [[ "$value" =~ ^[A-Za-z]:\\ ]]; then
    cygpath -u "$value"
  else
    printf '%s' "$value"
  fi
}

SOURCE_ARCHIVE="$(to_unix_path "${NGSPICE_SOURCE_ARCHIVE:-${ROOT_DIR}/third_party/ngspice-46.tar.gz}")"
SOURCE_DIR="$(to_unix_path "${NGSPICE_SOURCE_DIR:-${ROOT_DIR}/third_party/ngspice-46}")"
BUILD_DIR="$(to_unix_path "${NGSPICE_BUILD_DIR:-${ROOT_DIR}/wasm-build/work/ngspice-46}")"
OUTPUT_DIR="$(to_unix_path "${NGSPICE_OUTPUT_DIR:-${ROOT_DIR}/wasm-lib}")"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tool emcc
require_tool emconfigure
require_tool emmake
require_tool make
require_tool node
require_tool tar

if [[ ! -d "$SOURCE_DIR" ]]; then
  if [[ ! -f "$SOURCE_ARCHIVE" ]]; then
    echo "Source directory not found: $SOURCE_DIR" >&2
    echo "Source archive not found: $SOURCE_ARCHIVE" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$SOURCE_DIR")"
  tar -xzf "$SOURCE_ARCHIVE" -C "$(dirname "$SOURCE_DIR")"
fi

if [[ ! -x "${SOURCE_DIR}/configure" ]]; then
  echo "ngspice configure script not found: ${SOURCE_DIR}/configure" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
cd "$BUILD_DIR"

export CFLAGS="${CFLAGS:--O2}"
export CXXFLAGS="${CXXFLAGS:--O2}"
export LDFLAGS="${LDFLAGS:-} -O2 \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createNgspiceModule \
  -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 \
  -sFORCE_FILESYSTEM=1 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=1 \
  -sEXPORTED_FUNCTIONS=_main \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain"

emconfigure "${SOURCE_DIR}/configure" \
  --host=wasm32-unknown-emscripten \
  --disable-dependency-tracking \
  --disable-shared \
  --enable-static \
  --disable-xspice \
  --disable-cider \
  --disable-osdi \
  --disable-openmp \
  --disable-klu \
  --with-readline=no \
  --with-editline=no \
  --disable-debug \
  --without-x \
  ac_cv_exeext=.js

emmake make -j "$JOBS"

NGSPICE_JS="$(find "$BUILD_DIR" -type f \( -name 'ngspice.js' -o -name 'ngspice*.js' \) | head -n 1)"
NGSPICE_WASM="$(find "$BUILD_DIR" -type f \( -name 'ngspice.wasm' -o -name 'ngspice*.wasm' \) | head -n 1)"

if [[ -z "$NGSPICE_JS" || -z "$NGSPICE_WASM" ]]; then
  echo "Build finished, but ngspice.js/ngspice.wasm was not found under: $BUILD_DIR" >&2
  echo "Check config.log and make output. Emscripten may have produced a different executable name." >&2
  exit 1
fi

cp "$NGSPICE_JS" "${OUTPUT_DIR}/ngspice.js"
cp "$NGSPICE_WASM" "${OUTPUT_DIR}/ngspice.wasm"
cp "${ROOT_DIR}/iframe/wasm/ngspice-global.js" "${OUTPUT_DIR}/ngspice-global.js"
cp "${SOURCE_DIR}/COPYING" "${OUTPUT_DIR}/NGSPICE-COPYING.txt"
cp "${SOURCE_DIR}/AUTHORS" "${OUTPUT_DIR}/NGSPICE-AUTHORS.txt"

node "${SCRIPT_DIR}/embed-wasm-binary.mjs" \
  "${OUTPUT_DIR}/ngspice.wasm" \
  "${OUTPUT_DIR}/ngspice-wasm-binary.js"

echo "ngspice WASM build complete:"
echo "  ${OUTPUT_DIR}/ngspice.js"
echo "  ${OUTPUT_DIR}/ngspice.wasm"
echo "  ${OUTPUT_DIR}/ngspice-wasm-binary.js"
echo "  ${OUTPUT_DIR}/ngspice-global.js"

