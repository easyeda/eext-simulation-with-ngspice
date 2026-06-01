# iframe WASM 运行资源

该目录是插件实际打包进 `.eext` 的 ngspice WASM 运行目录。

## 文件说明

- `ngspice.js`：Emscripten 生成的 loader。
- `ngspice.wasm`：ngspice 46 主 WASM，已启用 XSPICE。
- `ngspice-wasm-binary.js`：主 WASM 的 base64 内嵌版本，用于绕过 iframe 环境直接 fetch `.wasm` 失败的问题。
- `ngspice-global.js`：把 loader 暴露为 `window.createNgspiceModule`。
- `ngspice-xspice-codemodels.js`：XSPICE `.cm` side modules 的 base64 内嵌版本。
- `NGSPICE-COPYING.txt` / `NGSPICE-AUTHORS.txt`：ngspice 许可证与作者信息。

## XSPICE 加载方式

`src/wasm-ngspice-runner.ts` 会在运行前：

1. 解码 `__JLC_NGSPICE_XSPICE_CODEMODELS`。
2. 写入 Emscripten 虚拟文件系统的 `/usr/lib/ngspice/*.cm`。
3. 写入 `/usr/share/ngspice/scripts/spinit`。
4. 调用 `loadDynamicLibrary(..., { global: true, nodelete: true, allowUndefined: true })` 预加载侧模块。

这相当于让主 `ngspice.wasm` 使用一组额外的 XSPICE side module WASM。

## 重新生成

```powershell
.\wasm-build\build-ngspice-wasm.windows.ps1 -Jobs 8
npm.cmd run build
```
