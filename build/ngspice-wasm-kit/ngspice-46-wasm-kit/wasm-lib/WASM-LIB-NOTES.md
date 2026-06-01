# NGspice WASM 库说明

这个目录保存可直接给插件使用的 NGspice 46 WASM 产物。

文件说明：

- `ngspice.js`：Emscripten 生成的 loader，提供 `createNgspiceModule` factory。
- `ngspice.wasm`：NGspice WebAssembly 二进制。
- `ngspice-wasm-binary.js`：将 `ngspice.wasm` 转成 base64 chunks，插件运行时优先使用它，避免 EasyEDA iframe 拉取 `.wasm` 失败。
- `ngspice-global.js`：把 loader 暴露到 `globalThis/window.createNgspiceModule`。
- `NGSPICE-COPYING.txt`、`NGSPICE-AUTHORS.txt`：ngspice 许可与作者信息。
- `manifest.json`：当前库文件大小、SHA256、源码来源和编译版本记录。

需要替换插件内置库时，将本目录中的文件复制到：

```text
iframe/wasm/
```
