# NGspice WASM 编译说明

本文档说明如何从 ngspice 46 源码复现编译插件使用的 WASM 库。

## 当前已整理的文件

源码与库已经放在项目内：

```text
third_party/ngspice-46.tar.gz       # 官方 ngspice 46 源码包
third_party/ngspice-46/             # 已解压源码
wasm-lib/                           # 当前插件可直接使用的 WASM 库
wasm-build/build-ngspice-wasm.sh    # Linux / WSL / Git Bash 编译脚本
wasm-build/build-ngspice-wasm.ps1   # PowerShell 包装脚本
wasm-build/embed-wasm-binary.mjs    # 生成 ngspice-wasm-binary.js 的工具
wasm-lib/manifest.json              # 当前 WASM 库文件校验信息
```

`wasm-lib/` 里的库已经和当前插件的 `iframe/wasm/` 保持一致，可直接复制使用。

## 输出文件

编译完成后会生成：

```text
wasm-lib/ngspice.js
wasm-lib/ngspice.wasm
wasm-lib/ngspice-wasm-binary.js
wasm-lib/ngspice-global.js
wasm-lib/NGSPICE-COPYING.txt
wasm-lib/NGSPICE-AUTHORS.txt
wasm-lib/manifest.json
```

插件实际运行时会加载：

```html
<script src="/iframe/wasm/ngspice.js"></script>
<script src="/iframe/wasm/ngspice-global.js"></script>
<script src="/iframe/wasm/ngspice-wasm-binary.js"></script>
```

`ngspice-wasm-binary.js` 会把 `ngspice.wasm` 内嵌为 base64，运行器再通过 `wasmBinary` 传给 Emscripten。这样可以绕开某些 iframe 环境里 `.wasm` 文件无法直接 fetch 的问题。

## 推荐编译环境

推荐使用 WSL Ubuntu 或 Linux。Windows 原生也可以，但需要 MSYS2/Git Bash、make 和 Emscripten 环境变量配合，出错概率更高。

建议版本：

- ngspice：`46`
- Emscripten：`5.0.7`
- Node.js：`>=20`
- make、bash、tar

安装 Emscripten：

```bash
git clone https://github.com/emscripten-core/emsdk.git
cd emsdk
./emsdk install 5.0.7
./emsdk activate 5.0.7
source ./emsdk_env.sh
```

确认工具链：

```bash
emcc --version
emconfigure --version
emmake --version
node --version
make --version
```

## 一键编译

在项目根目录执行：

```bash
bash wasm-build/build-ngspice-wasm.sh
```

如果要指定源码、构建目录或输出目录：

```bash
NGSPICE_SOURCE_DIR=/path/to/ngspice-46 \
NGSPICE_BUILD_DIR=/tmp/ngspice-46-wasm-build \
NGSPICE_OUTPUT_DIR=/path/to/output \
JOBS=8 \
bash wasm-build/build-ngspice-wasm.sh
```

PowerShell 入口：

```powershell
.\wasm-build\build-ngspice-wasm.ps1
```

如果 PowerShell 报 `Missing required tool: emcc`，说明当前 shell 没有激活 Emscripten。请先进入已执行 `emsdk_env` 的环境，或改用 WSL 执行 `.sh` 脚本。

## 编译参数

ngspice configure 参数：

```text
--host=wasm32-unknown-emscripten
--disable-dependency-tracking
--disable-shared
--enable-static
--disable-xspice
--disable-cider
--disable-osdi
--disable-openmp
--disable-klu
--with-readline=no
--with-editline=no
--disable-debug
--without-x
ac_cv_exeext=.js
```

Emscripten 链接参数：

```text
-sMODULARIZE=1
-sEXPORT_NAME=createNgspiceModule
-sENVIRONMENT=web,worker
-sALLOW_MEMORY_GROWTH=1
-sFORCE_FILESYSTEM=1
-sINVOKE_RUN=0
-sEXIT_RUNTIME=1
-sEXPORTED_FUNCTIONS=_main
-sEXPORTED_RUNTIME_METHODS=FS,callMain
```

这些参数的目的：

- `MODULARIZE + EXPORT_NAME`：让 loader 暴露 `createNgspiceModule()`。
- `FORCE_FILESYSTEM`：保留 Emscripten 虚拟文件系统，插件要写入网表并读取 raw 文件。
- `INVOKE_RUN=0`：加载模块时不自动运行，插件运行时再调用 `callMain()`。
- `ALLOW_MEMORY_GROWTH`：允许大型仿真时内存增长。
- `set filetype=ascii`：由插件运行器写入控制命令，便于 TypeScript 解析 raw。
- `set plotwinsize=0`：关闭 ngspice 内部压缩，保留更多原始点。

## 手动编译步骤

脚本内部等价于以下流程：

```bash
mkdir -p wasm-build/work/ngspice-46 wasm-lib
cd wasm-build/work/ngspice-46

export CFLAGS="-O2"
export CXXFLAGS="-O2"
export LDFLAGS="-O2 -sMODULARIZE=1 -sEXPORT_NAME=createNgspiceModule -sENVIRONMENT=web,worker -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=1 -sEXPORTED_FUNCTIONS=_main -sEXPORTED_RUNTIME_METHODS=FS,callMain"

emconfigure ../../../third_party/ngspice-46/configure \
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

emmake make -j8
```

然后找到生成的 `ngspice.js` 和 `ngspice.wasm`，复制到 `wasm-lib/`，再执行：

```bash
node wasm-build/embed-wasm-binary.mjs wasm-lib/ngspice.wasm wasm-lib/ngspice-wasm-binary.js
```

## 接入插件

如果你重新编译了库，把这些文件复制到插件运行目录：

```text
wasm-lib/ngspice.js                 -> iframe/wasm/ngspice.js
wasm-lib/ngspice.wasm               -> iframe/wasm/ngspice.wasm
wasm-lib/ngspice-wasm-binary.js     -> iframe/wasm/ngspice-wasm-binary.js
wasm-lib/ngspice-global.js          -> iframe/wasm/ngspice-global.js
wasm-lib/NGSPICE-COPYING.txt        -> iframe/wasm/NGSPICE-COPYING.txt
wasm-lib/NGSPICE-AUTHORS.txt        -> iframe/wasm/NGSPICE-AUTHORS.txt
```

之后重新打插件包：

```bash
npx tsc --noEmit
npm run build
```

## 常见问题

### 1. `emcc` 找不到

说明没有安装或没有激活 Emscripten：

```bash
source /path/to/emsdk/emsdk_env.sh
```

Windows 上如果用 PowerShell，需要先执行 emsdk 提供的环境脚本，或直接用 WSL。

### 2. `make` 找不到

WSL / Linux：

```bash
sudo apt install make
```

Windows 原生请安装 MSYS2 make，或者改用 WSL。

### 3. 编译成功但没有 `ngspice.js`

检查 `wasm-build/work/ngspice-46/config.log` 和 make 输出。重点确认：

- `ac_cv_exeext=.js` 是否生效。
- `LDFLAGS` 是否被最终链接命令使用。
- `emcc` 是否真的替代了系统 `gcc`。

### 4. 插件提示 WASM loader 未注入

确认 `iframe/index.html` 中仍然按顺序加载：

```html
ngspice.js
ngspice-global.js
ngspice-wasm-binary.js
```

并确认 `ngspice-global.js` 能把 factory 暴露为：

```js
window.createNgspiceModule
```

### 5. 仿真失败但 WASM 能加载

这通常是网表或模型问题，不是 WASM loader 问题。看底部日志里 ngspice 输出，例如：

```text
Unable to find definition of model
Simulation interrupted due to error
ngspice WASM 未生成 raw 波形文件
```

## 许可注意

ngspice 使用 Modified BSD 许可。发布插件时需要保留：

```text
NGSPICE-COPYING.txt
NGSPICE-AUTHORS.txt
```

插件自己的 `extension.json` 已标注：

```json
"license": "NGspice License (Modified BSD)"
```
