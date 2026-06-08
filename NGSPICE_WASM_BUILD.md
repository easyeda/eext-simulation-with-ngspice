# NGspice WASM / XSPICE 构建说明

本项目内置的 `ngspice.wasm` 已基于 **ngspice 46 + Emscripten 5.0.7** 重新编译，并启用 XSPICE。插件运行时会同时加载主 WASM 和 XSPICE code model 侧模块。

## 当前交付文件

插件实际打包使用这些文件：

```text
iframe/wasm/ngspice.js
iframe/wasm/ngspice.wasm
iframe/wasm/ngspice-wasm-binary.js
iframe/wasm/ngspice-global.js
iframe/wasm/ngspice-xspice-codemodels.js
iframe/wasm/NGSPICE-COPYING.txt
iframe/wasm/NGSPICE-AUTHORS.txt
```

其中：

- `ngspice.wasm`：主 ngspice WASM，编译参数包含 `--enable-xspice`。
- `ngspice-xspice-codemodels.js`：把 `analog.cm`、`digital.cm` 等 XSPICE 侧模块嵌入为 base64，避免插件 iframe 环境额外 fetch `.cm/.wasm` 文件失败。
- `ngspice-wasm-binary.js`：把主 `ngspice.wasm` 嵌入为 base64，避免部分环境不能直接加载 `.wasm`。

## 一键构建：Windows 推荐入口

在一台新的 Windows 机器上，推荐直接运行：

```powershell
.\wasm-build\build-ngspice-wasm.windows.ps1 -Jobs 8
```

默认会启用增量编译：脚本复用 `wasm-build/work/ngspice-46/`，并在 configure 输入没有变化时跳过 `configure`。如果需要完全清理后重编，再显式加 `-Clean`：

```powershell
.\wasm-build\build-ngspice-wasm.windows.ps1 -Jobs 8 -Clean
```

本地调试如果想缩短 Emscripten 链接优化时间，可以使用 `-LinkMode fast`。发布包仍建议使用默认的 `-LinkMode release`：

```powershell
.\wasm-build\build-ngspice-wasm.windows.ps1 -Jobs 8 -LinkMode fast
```

这个脚本会自动处理：

- 检查并使用项目内置的 `third_party/emsdk`；如果缺失，会安装/激活 `emsdk 5.0.7` 到该目录。
- 检查 MSYS2；如未安装且系统有 `winget`，会自动安装 MSYS2。
- 通过 MSYS2 安装 `base-devel`、`mingw-w64-x86_64-gcc`、`tar/gzip/xz` 等构建工具。
- 调用 `wasm-build/build-ngspice-wasm.sh` 编译主 WASM 和 XSPICE `.cm` 侧模块。
- 生成 `ngspice-wasm-binary.js` 和 `ngspice-xspice-codemodels.js`。
- 自动同步产物到 `iframe/wasm/`。

如果机器已经装好工具链，只想复用现有工具：

```powershell
.\wasm-build\build-ngspice-wasm.windows.ps1 -SkipToolBootstrap -Jobs 8
```

> 说明：ngspice 的 autotools 构建仍需要 `bash/make/sed/gcc` 这类 Unix 构建工具。Windows 脚本的目标是“不要求人工预装/配置 MSYS2”，而不是完全绕开这类构建工具。

## Linux / WSL / 已激活 emsdk 环境

```bash
JOBS=8 bash wasm-build/build-ngspice-wasm.sh
node wasm-build/embed-xspice-codemodels.mjs
cp wasm-lib/ngspice* iframe/wasm/
cp wasm-lib/NGSPICE-* iframe/wasm/
```

也可以指定路径：

```bash
NGSPICE_SOURCE_DIR=/path/to/ngspice-46 \
NGSPICE_BUILD_DIR=/tmp/ngspice-46-wasm-build \
NGSPICE_OUTPUT_DIR=/path/to/output \
JOBS=8 \
bash wasm-build/build-ngspice-wasm.sh
```

## 关键编译参数

ngspice configure 参数：

```text
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
```

Emscripten 链接参数：

```text
-sMODULARIZE=1
-sEXPORT_NAME=createNgspiceModule
-sENVIRONMENT=web,worker,node
-sALLOW_MEMORY_GROWTH=1
-sMAIN_MODULE=1
-Wl,--allow-multiple-definition
-sFORCE_FILESYSTEM=1
-sINVOKE_RUN=0
-sEXIT_RUNTIME=1
-sEXPORTED_FUNCTIONS=_main
-sEXPORTED_RUNTIME_METHODS=FS,callMain,loadDynamicLibrary
```

XSPICE 需要：

- 主模块使用 `MAIN_MODULE=1`。
- XSPICE `.cm` 使用 `SIDE_MODULE=1`。
- 运行时暴露 `loadDynamicLibrary`。
- 插件启动后把 `.cm` 写入 Emscripten FS 的 `/usr/lib/ngspice/`，并写入 `/usr/share/ngspice/scripts/spinit`。

## 重新打插件包

WASM 产物同步到 `iframe/wasm/` 后执行：

```powershell
npm.cmd run build
```

当前生成的插件包位置：

```text
build/dist/simulation-with-ngspice_v1.2.1.eext
```

## XSPICE 验证

可以用最小 delay 模型确认 XSPICE 已加载：

```spice
XSPICE delay smoke
ain in out ctl dly
.model dly delay(delay=1u)
V1 in 0 pulse(0 1 0 1n 1n 5u 10u)
Vc ctl 0 0
.control
set noaskquit
tran 1u 20u
print v(out)
quit
.endc
.end
```

如果能看到 `Reducing trtol to 1 for xspice 'A' devices` 且没有 `unable to find definition of model`，说明 XSPICE code models 已加载成功。

## 清理策略

这些目录/文件是中间产物，可删除后重新生成：

```text
wasm-build/work/
wasm-lib/
dist/
build/dist/*.eext（保留当前要发布的包即可）
```

`third_party/emsdk/` 是项目内置 Emscripten 工具链，用来让其他机器只安装 MSYS2 就能本地复现 WASM 构建，不再作为普通中间产物清理。

真正会进入插件包的是 `.edaignore` 过滤后的文件，尤其是 `iframe/wasm/` 和 `dist/`。
