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

WRAPPER_DIR=""

ensure_tool_wrapper() {
  local tool="$1"
  if command -v "$tool" >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v "${tool}.bat" >/dev/null 2>&1; then
    return 0
  fi
  if [[ -z "$WRAPPER_DIR" ]]; then
    WRAPPER_DIR="$(mktemp -d)"
    export PATH="${WRAPPER_DIR}:${PATH}"
  fi
  cat > "${WRAPPER_DIR}/${tool}" <<EOF
#!/usr/bin/env bash
exec ${tool}.bat "\$@"
EOF
  chmod +x "${WRAPPER_DIR}/${tool}"
}

ensure_tool_wrapper emcc
ensure_tool_wrapper em++
ensure_tool_wrapper emar
ensure_tool_wrapper emranlib
ensure_tool_wrapper emnm
ensure_tool_wrapper emconfigure
ensure_tool_wrapper emmake

USE_DIRECT_EMSCRIPTEN_TOOLS=0
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    USE_DIRECT_EMSCRIPTEN_TOOLS=1
    ;;
esac

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required tool: $1" >&2
    exit 1
  fi
}

require_tool emcc
if [[ "$USE_DIRECT_EMSCRIPTEN_TOOLS" != "1" ]]; then
  require_tool emconfigure
  require_tool emmake
fi
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

CONFIGURE_COMMAND=("${SOURCE_DIR}/configure")
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    CONFIGURE_COMMAND=(bash "${SOURCE_DIR}/configure")
    ;;
esac

export CFLAGS="${CFLAGS:--O2 -include stdlib.h}"
export CXXFLAGS="${CXXFLAGS:--O2 -include stdlib.h}"
export LDFLAGS="${LDFLAGS:-} -O2 \
  -Wl,--allow-multiple-definition \
  -sMODULARIZE=1 \
  -sEXPORT_NAME=createNgspiceModule \
  -sENVIRONMENT=web,worker,node \
  -sALLOW_MEMORY_GROWTH=1 \
  -sMAIN_MODULE=1 \
  -sFORCE_FILESYSTEM=1 \
  -sINVOKE_RUN=0 \
  -sEXIT_RUNTIME=1 \
  -sEXPORTED_FUNCTIONS=_main \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,loadDynamicLibrary"

CONFIGURE_ARGS=(
  --host=wasm32-unknown-emscripten
  --disable-dependency-tracking
  --disable-shared
  --enable-static
  --enable-xspice
  --disable-cider
  --disable-osdi
  --disable-openmp
  --disable-klu
  --with-readline=no
  --with-editline=no
  --disable-debug
  --without-x
  ac_cv_exeext=.js
)

if [[ "$USE_DIRECT_EMSCRIPTEN_TOOLS" = "1" ]]; then
  CC=emcc \
  CXX=em++ \
  AR=emar \
  RANLIB=emranlib \
  NM=emnm \
  cross_compiling=yes \
  "${CONFIGURE_COMMAND[@]}" "${CONFIGURE_ARGS[@]}"
  mkdir -p src/xspice/cmpp/build
  gcc \
    -I src/xspice/cmpp \
    -I "${SOURCE_DIR}/src/xspice/cmpp" \
    -o src/xspice/cmpp/build/cmpp.exe \
    "${SOURCE_DIR}/src/xspice/cmpp/main.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/file_buffer.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/pp_ifs.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/pp_lst.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/pp_mod.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/read_ifs.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/writ_ifs.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/util.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/ifs_lex.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/ifs_yacc.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/mod_lex.c" \
    "${SOURCE_DIR}/src/xspice/cmpp/mod_yacc.c" \
    -lshlwapi
  sed -i 's|^CMPP = .*$|CMPP = $(top_builddir)/src/xspice/cmpp/build/cmpp.exe|' src/xspice/icm/makedefs
  sed -i 's|^LDFLAGS = -shared.*$|LDFLAGS = -shared -sSIDE_MODULE=1|' src/xspice/icm/makedefs
  sed -i 's|^    cmpp = ../cmpp/cmpp.exe$|    cmpp = ../../../src/xspice/cmpp/build/cmpp.exe|' src/xspice/icm/GNUmakefile
  sed -i 's|^    cmpp = ../cmpp/cmpp$|    cmpp = ../../../src/xspice/cmpp/build/cmpp.exe|' src/xspice/icm/GNUmakefile
  sed -i 's|^SUBDIRS = .*$|SUBDIRS = mif cm enh evt idn cmpp icm|' src/xspice/Makefile
  make -j "$JOBS"
else
  emconfigure "${CONFIGURE_COMMAND[@]}" "${CONFIGURE_ARGS[@]}"
  emmake make -j "$JOBS"
fi

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
