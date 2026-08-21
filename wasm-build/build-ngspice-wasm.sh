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

use_bundled_emsdk() {
  local emsdk_root="${ROOT_DIR}/third_party/emsdk"
  local emscripten_root="${emsdk_root}/upstream/emscripten"
  if command -v emcc >/dev/null 2>&1 || [[ ! -f "${emscripten_root}/emcc.bat" ]]; then
    return 0
  fi

  local node_dir
  local python_dir
  node_dir="$(find "${emsdk_root}/node" -type f -name 'node.exe' -print -quit 2>/dev/null | xargs -r dirname)"
  python_dir="$(find "${emsdk_root}/python" -type f -name 'python.exe' -print -quit 2>/dev/null | xargs -r dirname)"
  if [[ -z "${node_dir}" || -z "${python_dir}" ]]; then
    echo "Bundled emsdk is present, but node.exe or python.exe was not found under: ${emsdk_root}" >&2
    exit 1
  fi

  export EMSDK="${emsdk_root}"
  export EM_CONFIG="${emsdk_root}/.emscripten"
  export EMSDK_NODE="${node_dir}/node.exe"
  export EMSDK_PYTHON="${python_dir}/python.exe"
  export PATH="${emsdk_root}:${emscripten_root}:${node_dir}:${python_dir}:${PATH}"
}

use_bundled_emsdk

SOURCE_ARCHIVE="$(to_unix_path "${NGSPICE_SOURCE_ARCHIVE:-${ROOT_DIR}/third_party/ngspice-46.tar.gz}")"
SOURCE_DIR="$(to_unix_path "${NGSPICE_SOURCE_DIR:-${ROOT_DIR}/third_party/ngspice-46}")"
BUILD_DIR="$(to_unix_path "${NGSPICE_BUILD_DIR:-${ROOT_DIR}/wasm-build/work/ngspice-46}")"
OUTPUT_DIR="$(to_unix_path "${NGSPICE_OUTPUT_DIR:-${ROOT_DIR}/wasm-lib}")"
SHAREDSPICE_WRAPPER_DIR="$(to_unix_path "${NGSPICE_SHAREDSPICE_WRAPPER_DIR:-${ROOT_DIR}/wasm-build/sharedspice-wrapper}")"
JOBS="${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}"
CLEAN_BUILD="${NGSPICE_CLEAN:-0}"
LINK_MODE="${NGSPICE_LINK_MODE:-release}"
case "$LINK_MODE" in
  release)
    LINK_OPTIMIZATION="-O2"
    ;;
  fast)
    LINK_OPTIMIZATION="-O1"
    ;;
  *)
    echo "Invalid NGSPICE_LINK_MODE: $LINK_MODE. Expected release or fast." >&2
    exit 1
    ;;
esac

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
  if [[ "$tool" = "emar" ]]; then
    cat > "${WRAPPER_DIR}/${tool}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

emar_bat="$(command -v emar.bat)"
emar_dir="$(dirname "$emar_bat")"
emar_py="${emar_dir}/emar.py"
python_exe="${EMSDK_PYTHON:-python}"
if command -v cygpath >/dev/null 2>&1 && [[ "$python_exe" =~ ^[A-Za-z]:\\ ]]; then
  python_exe="$(cygpath -u "$python_exe")"
fi

arg_len=0
for arg in "$@"; do
  arg_len=$((arg_len + ${#arg} + 1))
done

if (( arg_len > 20000 )); then
  rsp="$(mktemp)"
  trap 'rm -f "$rsp"' EXIT
  printf '%s\n' "$@" > "$rsp"
  "$python_exe" -E "$emar_py" @"$rsp"
else
  "$python_exe" -E "$emar_py" "$@"
fi
EOF
    chmod +x "${WRAPPER_DIR}/${tool}"
    return 0
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

if [[ "$CLEAN_BUILD" = "1" || "$CLEAN_BUILD" = "true" ]]; then
  echo "Clean build requested, removing generated ngspice source/build/output directories."
  echo "If this run is interrupted, rerun without NGSPICE_CLEAN to reuse the new build directory."
  rm -rf "$SOURCE_DIR" "$BUILD_DIR" "$OUTPUT_DIR"
else
  echo "Incremental build requested."
  echo "Reusing source/build/output directories when present; make will continue from existing objects."
fi

if [[ -d "$SOURCE_DIR" && ! -x "${SOURCE_DIR}/configure" ]]; then
  if [[ ! -f "$SOURCE_ARCHIVE" ]]; then
    echo "Source directory is incomplete and source archive was not found: $SOURCE_ARCHIVE" >&2
    exit 1
  fi
  echo "Source directory is incomplete, re-extracting: $SOURCE_DIR"
  rm -rf "$SOURCE_DIR"
fi

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

if [[ "$CLEAN_BUILD" = "1" || "$CLEAN_BUILD" = "true" ]]; then
  echo "Clean build enabled, starting from an empty build directory: $BUILD_DIR"
else
  echo "Incremental build enabled, reusing: $BUILD_DIR"
fi
mkdir -p "$BUILD_DIR" "$OUTPUT_DIR"
cd "$BUILD_DIR"

CONFIGURE_COMMAND=("${SOURCE_DIR}/configure")
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    CONFIGURE_COMMAND=(bash "${SOURCE_DIR}/configure")
    ;;
esac

export CFLAGS="${CFLAGS:--O2 -fPIC -include stdlib.h}"
export CXXFLAGS="${CXXFLAGS:--O2 -fPIC -include stdlib.h}"
export LDFLAGS="${LDFLAGS:-} ${LINK_OPTIMIZATION} \
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
  --with-ngshared
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

CONFIGURE_STAMP="${BUILD_DIR}/.ngspice-wasm-configure.stamp"
CONFIGURE_SIGNATURE="$(
  printf 'source=%s\n' "$SOURCE_DIR"
  printf 'cflags=%s\n' "$CFLAGS"
  printf 'cxxflags=%s\n' "$CXXFLAGS"
  printf 'ldflags=%s\n' "$LDFLAGS"
  printf 'link_mode=%s\n' "$LINK_MODE"
  printf 'direct_tools=%s\n' "$USE_DIRECT_EMSCRIPTEN_TOOLS"
  printf 'args=%s\n' "${CONFIGURE_ARGS[*]}"
)"

build_windows_cmpp_host() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) ;;
    *) return 0 ;;
  esac

  local cmpp_dir="${BUILD_DIR}/src/xspice/cmpp/build"
  local cmpp_exe="${cmpp_dir}/cmpp.exe"
  if [[ -x "$cmpp_exe" ]]; then
    return 0
  fi

  mkdir -p "$cmpp_dir"
  gcc \
    -I "${BUILD_DIR}/src/xspice/cmpp" \
    -I "${SOURCE_DIR}/src/xspice/cmpp" \
    -o "$cmpp_exe" \
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
}

patch_ngspice_wasm_makefiles() {
  if [[ -f "${SOURCE_DIR}/src/sharedspice.c" ]]; then
    sed -i 's/pfcn(outsend, userptr);/pfcn(outsend, ng_ident, userptr);/' "${SOURCE_DIR}/src/sharedspice.c"
    python - "$SOURCE_DIR/src/sharedspice.c" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace(
    '    if (!cp_getvar("nosighandling", CP_BOOL, NULL, 0))\n'
    '        old_sigsegv = signal(SIGSEGV, (SIGNAL_FUNCTION) sigsegvsh);\n',
    '#ifndef __EMSCRIPTEN__\n'
    '    if (!cp_getvar("nosighandling", CP_BOOL, NULL, 0))\n'
    '        old_sigsegv = signal(SIGSEGV, (SIGNAL_FUNCTION) sigsegvsh);\n'
    '#endif\n'
)
text = text.replace(
    '    if (!cp_getvar("nosighandling", CP_BOOL, NULL, 0))\n'
    '        signal(SIGSEGV, old_sigsegv);\n',
    '#ifndef __EMSCRIPTEN__\n'
    '    if (!cp_getvar("nosighandling", CP_BOOL, NULL, 0))\n'
    '        signal(SIGSEGV, old_sigsegv);\n'
    '#endif\n'
)
path.write_text(text)
PY
  fi

  if [[ ! -f "${BUILD_DIR}/Makefile" ]]; then
    return 0
  fi

  if [[ -f "${BUILD_DIR}/libtool" ]] && ! grep -q "^func__fatal_error ()" "${BUILD_DIR}/libtool"; then
    awk '
      {print}
      $0 ~ /^func_fatal_error \(\)/ {in_func=1}
      in_func && $0 ~ /^}$/ {
        print "";
        print "# 某些 libtool 模板要求 func__fatal_error，此处转发到 func_fatal_error。";
        print "func__fatal_error ()";
        print "{";
        print "    func_fatal_error \"$@\"";
        print "}";
        in_func=0;
      }
    ' "${BUILD_DIR}/libtool" > "${BUILD_DIR}/libtool.tmp"
    mv "${BUILD_DIR}/libtool.tmp" "${BUILD_DIR}/libtool"
    chmod +x "${BUILD_DIR}/libtool"
  fi

  find "$BUILD_DIR" -type f -name Makefile -exec sed -i 's/^STATIC = -shared$/STATIC = /' {} +

  if [[ -f "${BUILD_DIR}/src/Makefile" ]]; then
    sed -i 's/^libngspice_la_CFLAGS = -shared$/libngspice_la_CFLAGS = /' "${BUILD_DIR}/src/Makefile"
    sed -i 's/^libngspice_la_LDFLAGS = -shared /libngspice_la_LDFLAGS = /' "${BUILD_DIR}/src/Makefile"
  fi

  if [[ -f "${BUILD_DIR}/src/xspice/Makefile" ]]; then
    sed -i 's/^SUBDIRS = .*$/SUBDIRS = mif cm enh evt idn cmpp icm/' "${BUILD_DIR}/src/xspice/Makefile"
  fi

  build_windows_cmpp_host

  if [[ -f "${BUILD_DIR}/src/xspice/icm/makedefs" ]]; then
    sed -i 's|^CMPP = .*$|CMPP = $(top_builddir)/src/xspice/cmpp/build/cmpp.exe|' "${BUILD_DIR}/src/xspice/icm/makedefs"
    sed -i 's|^[[:space:]]*LDFLAGS = .*$|LDFLAGS = -s SIDE_MODULE=1|' "${BUILD_DIR}/src/xspice/icm/makedefs"
    sed -i 's|^CFLAGS = .*$|CFLAGS = -O2 -fPIC -include stdlib.h -fvisibility=hidden|' "${BUILD_DIR}/src/xspice/icm/makedefs"
  fi

  if [[ -f "${BUILD_DIR}/src/xspice/icm/GNUmakefile" ]]; then
    sed -i 's|^[[:space:]]*cmpp = .*$|    cmpp = $(CMPP)|' "${BUILD_DIR}/src/xspice/icm/GNUmakefile"
  fi
}

if [[ -f "$CONFIGURE_STAMP" ]] && [[ "$(cat "$CONFIGURE_STAMP")" = "$CONFIGURE_SIGNATURE" ]] && [[ -f Makefile ]]; then
  echo "Configure inputs unchanged, skipping configure."
else
  echo "Running configure."
  if [[ "$USE_DIRECT_EMSCRIPTEN_TOOLS" = "1" ]]; then
  CC=emcc \
  CXX=em++ \
  AR=emar \
  RANLIB=emranlib \
  NM=emnm \
  cross_compiling=yes \
  "${CONFIGURE_COMMAND[@]}" "${CONFIGURE_ARGS[@]}"
  else
    emconfigure "${CONFIGURE_COMMAND[@]}" "${CONFIGURE_ARGS[@]}"
  fi
  printf '%s' "$CONFIGURE_SIGNATURE" > "$CONFIGURE_STAMP"
fi

patch_ngspice_wasm_makefiles

make -j "$JOBS"

build_sharedspice_wrapper_module() {
  local libngspice="${BUILD_DIR}/src/.libs/libngspice.a"
  if [[ ! -d "$SHAREDSPICE_WRAPPER_DIR" ]]; then
    echo "Sharedspice wrapper directory not found: $SHAREDSPICE_WRAPPER_DIR" >&2
    return 1
  fi
  if [[ ! -f "$libngspice" ]]; then
    echo "libngspice.a was not built: $libngspice" >&2
    echo "The sharedspice wrapper requires configure --with-ngshared to produce this archive." >&2
    return 1
  fi

  local embed_args=()
  local model
  for model in spice2poly analog digital xtradev xtraevt table tlines; do
    local cm_path="${BUILD_DIR}/src/xspice/icm/${model}/${model}.cm"
    if [[ -f "$cm_path" ]]; then
      embed_args+=(--embed-file "${cm_path}@/usr/local/lib/ngspice/${model}.cm")
      embed_args+=(--embed-file "${cm_path}@/usr/lib/ngspice/${model}.cm")
    fi
  done

  local spinit_path="${BUILD_DIR}/src/spinit"
  if [[ -f "$spinit_path" ]]; then
    embed_args+=(--embed-file "${spinit_path}@/usr/local/share/ngspice/scripts/spinit")
    embed_args+=(--embed-file "${spinit_path}@/usr/share/ngspice/scripts/spinit")
  fi

  echo "Building NgSpiceWasm embind module from: $SHAREDSPICE_WRAPPER_DIR"
  em++ -o "${OUTPUT_DIR}/ngspice.js" \
    "${SHAREDSPICE_WRAPPER_DIR}/ngspice_de_cpp.cpp" \
    "${SHAREDSPICE_WRAPPER_DIR}/ngspice_wasm_stubs.c" \
    "${SHAREDSPICE_WRAPPER_DIR}/main_stub.c" \
    -Wl,--whole-archive "$libngspice" -Wl,--no-whole-archive \
    -I"${SHAREDSPICE_WRAPPER_DIR}" \
    -I"${SOURCE_DIR}/src/include/ngspice" \
    -I"${SOURCE_DIR}/src/include" \
    -I"${BUILD_DIR}/src/include/ngspice" \
    -I"${BUILD_DIR}/src/include" \
    -Wl,--allow-multiple-definition \
    -sMAIN_MODULE=1 \
    -sMODULARIZE=1 \
    -sEXPORT_NAME=createNgspiceModule \
    -sENVIRONMENT=web,worker,node \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=536870912 \
    -sSTACK_SIZE=8388608 \
    -sFORCE_FILESYSTEM=1 \
    -sINVOKE_RUN=0 \
    -sEXIT_RUNTIME=1 \
    -sEXPORTED_RUNTIME_METHODS="['loadDynamicLibrary','ccall','cwrap','addFunction','UTF8ToString','stringToUTF8','FS','ENV']" \
    -sERROR_ON_UNDEFINED_SYMBOLS=0 \
    -sASSERTIONS=0 \
    "${embed_args[@]}" \
    --bind
}

build_sharedspice_wrapper_module
cp "${SCRIPT_DIR}/ngspice-global.js" "${OUTPUT_DIR}/ngspice-global.js"
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
