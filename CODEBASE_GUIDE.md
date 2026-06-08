# 源码快速上手指南

本文用于快速理解 `NGspice 波形仿真` 插件的源码结构、运行流程和打包方式。当前扩展包名以 `extension.json` 为准：`simulation-with-ngspice`，版本为 `V1.2.1`。

## 项目定位

这是一个面向嘉立创 EDA 专业版的 NGspice 本地仿真与波形查看插件。当前主线是纯 WASM 内置方案，不依赖用户额外下载或常驻启动本地原生 NGspice 服务。

插件主要做四件事：

- 接收 EDA 仿真事件中的 `netlist` 与 `probeNodes`，自动打开波形面板、导入网表并运行仿真。
- 通过菜单打开空白波形界面，供用户手动导入或粘贴自定义 NGspice 网表。
- 在 iframe 页面中导入、粘贴或接收网表，并用内置 NGspice WASM 在浏览器本地运行仿真。
- 将 transient、AC、DC 仿真结果解析为统一 `WaveformDataset`，再用 ECharts 绘制波形。

## 目录结构

```text
easyeda-ngspice-waveform-plugin/
├─ extension.json              # EDA 扩展清单，定义插件名、菜单、入口、版本等
├─ package.json                # Node 依赖和构建脚本
├─ README.md                   # 扩展详情页 README
├─ CHANGELOG.md                # 版本更新记录
├─ LICENSE                     # 许可说明
├─ .edaignore                  # 打包 .eext 时排除的文件规则
├─ src/
│  ├─ index.ts                 # 插件主入口：菜单、iframe、EDA 仿真事件、MessageBus
│  ├─ iframe.ts                # 波形界面主逻辑：UI、导入、运行、日志、曲线选择
│  ├─ engine-runner.ts         # 仿真运行入口，目前只走内置 WASM
│  ├─ wasm-ngspice-runner.ts   # WASM 加载、运行、raw 文件解析
│  ├─ messages.ts              # 主入口和 iframe 之间的 MessageBus topic 与消息类型
│  └─ shared/
│     ├─ types.ts              # 波形数据结构定义
│     ├─ netlist.ts            # 网表识别、分析命令提取、AC 单位兼容
│     ├─ probes.ts             # EDA 探针归一化、XAM 电流探针处理、默认显示曲线匹配
│     ├─ ngspice-normalize.ts  # 外部/旧协议波形消息归一化
│     └─ waveform-chart.ts     # ECharts 波形封装、缩放、拖拽、下采样、坐标轴格式化
├─ iframe/
│  ├─ index.html               # iframe 页面壳，加载 CSS、WASM loader 和 dist/iframe.js
│  ├─ styles.css               # 波形界面样式
│  └─ wasm/                    # 实际打包进 .eext 的 NGspice WASM 运行资源
├─ images/                     # logo、功能图、演示 GIF
├─ config/                     # esbuild 配置
├─ build/packaged.ts           # 读取 .edaignore 并生成 .eext 包
└─ tools/                      # 历史本地启动器方案保留文件，当前主流程不依赖
```

## 关键入口

### `extension.json`

扩展清单当前重点字段：

- `name`: `simulation-with-ngspice`
- `uuid`: `da6f02cde1cd4384abe56140588973be`
- `version`: `1.2.1`
- `entry`: `./dist/index`
- `activationEvents`: `{ "onStartupFinished": true }`，EDA 启动完成后会调用 `activate('onStartupFinished', ...)`
- `headerMenus.sch`: 原理图页面顶部菜单

菜单动作：

- `OpenWaveformPanel`: 只打开波形界面，用户可手动导入或粘贴网表。

### `src/index.ts`

插件主入口，运行在 EDA 插件上下文中。

负责：

- `activate(status, arg)`: 在 `onStartupFinished` 阶段注册 MessageBus RPC 和 EDA 仿真事件监听。
- `openWaveformPanel()`: 打开 `/iframe/index.html` 波形窗口，并清空最近一次 EDA 网表缓存，供用户手动导入自定义网表。
- `receiveEdaSimulationNetlist()`: 接收 EDA 仿真事件中的 `netlist` 和 `probeNodes`，缓存为带 `autoRun` 的 `NetlistImportMessage` 并发布给 iframe。
- `publishLatestLater()`: 多次延迟发布最近一次网表，提升 iframe 首次打开时收到消息的稳定性。

关键 EDA API：

```ts
eda.sch_Event.addSimulationEnginePullEventListener(...)
eda.sys_IFrame.openIFrame(...)
eda.sys_MessageBus.publishPublic(...)
eda.sys_MessageBus.rpcServicePublic(...)
```

### `src/iframe.ts`

波形界面主逻辑，运行在 `/iframe/index.html` 页面中。

负责：

- 渲染顶部工具栏、左侧网表编辑器、右侧波形图、底部日志、曲线选择弹窗。
- 接收主入口通过 MessageBus 发送的 `NetlistImportMessage`。
- 保存 `currentProbeNodes`，用于仿真结果的默认曲线选择。
- 手动导入文件、加载示例或编辑网表时清空 `currentProbeNodes`，避免沿用上一份 EDA 探针。
- 点击运行后调用 `runNgspiceNetlist(netlist, { probeNodes })`。
- 根据 `preferredTraceIdsByDataset` 初始化 `traceSelection`，让 EDA 探针对应曲线默认选中。
- 对同一份网表消息做 `netlistImportKey()` 去重，避免延迟重复广播在仿真完成后清空波形。
- 仿真完成后通过 `queueTraceDialogOpen()` 延后打开曲线选择弹窗，减少首次运行时闪烁或波形不显示。

### `src/shared/probes.ts`

探针相关工具层。

负责：

- `normalizeEdaProbeNodes()`: 兼容 `ProbeNode`、`ProbeType`、`LowLevel`、`HighLevel` / `HightLevel` 等字段。
- `extractCurrentProbes()`: 识别网表中的 `XAM` 电流探针。
- `augmentNetlistWithProbeSaves()`: 给 EDA 电压探针和 `XAM` 电流探针自动补 `.save`，确保 raw 中有可解析向量。
- `addSyntheticCurrentProbeTraces()`: 按 `(V(nodeA) - V(nodeB)) / 1e-3` 合成电流曲线。
- `preferredTraceIdsByDataset()`: 按探针节点名匹配已有 trace，生成默认显示曲线 id 列表。

### `src/engine-runner.ts`

仿真入口层。它屏蔽具体引擎实现，给 iframe 一个稳定接口：

```ts
runNgspiceNetlist(netlist, { probeNodes }): Promise<SimulationResponse>
getEngineStatus(): Promise<RunnerStatus>
```

当前实现只使用插件内置 WASM：

```ts
runNgspiceNetlistWithWasm(netlist, {
  wasmBaseUrl: '/iframe/wasm',
  timeoutMs: 60_000,
  probeNodes,
})
```

### `src/wasm-ngspice-runner.ts`

WASM 仿真核心。

主要步骤：

1. 检查或加载 `ngspice.js`。
2. 从 `ngspice-wasm-binary.js` 读取内嵌 WASM 二进制。
3. 调用 `normalizeNetlistForNgspice()` 兼容 AC 频率写法，例如 `1M` 转为 `1Meg`。
4. 调用 `augmentNetlistWithProbeSaves()` 为探针补 `.save`。
5. 生成 batch netlist，通过 `.control` / `write result.raw all` 输出 ASCII raw。
6. 写入 Emscripten 虚拟文件系统。
7. 调用 `module.callMain(["-b", "-o", logPath, inputPath])` 执行 ngspice。
8. 读取并解析 ASCII raw。
9. 调用 `addSyntheticCurrentProbeTraces()` 合成 `XAM` 电流曲线。
10. 调用 `preferredTraceIdsByDataset()` 生成探针默认选中曲线。

## 运行流程

### 菜单自定义网表流程

```text
用户点击原理图菜单
  -> 打开 iframe
  -> 用户手动导入 / 粘贴自定义网表
  -> 用户点击运行
  -> WASM 仿真并解析 raw
  -> 曲线选择和 ECharts 渲染
```

### EDA 仿真事件流程

```text
EDA 触发 SIMULATE_NETLIST
  -> src/index.ts 先自动打开 iframe
  -> 接收 props.netlist / props.probeNodes
  -> 缓存带 autoRun 的 NetlistImportMessage
  -> MessageBus 发布网表和探针
  -> iframe 保存 currentProbeNodes
  -> iframe 自动运行仿真
  -> WASM 仿真、解析 raw、合成 XAM 电流曲线
  -> 按探针节点名生成 preferredTraceIdsByDataset
  -> iframe 初始化 traceSelection
  -> 探针对应曲线默认显示
```

## 数据结构

主入口发送给 iframe 的网表消息：

```ts
interface NetlistImportMessage {
  type: 'simulation-netlist';
  source: 'EasyEDA Pro' | 'local-file' | 'paste';
  fileName: string;
  netlist: string;
  analysisType: AnalysisType;
  command: string;
  lineCount: number;
  importedAt: number;
  probeNodes?: EdaProbeNode[];
}
```

仿真结果统一结构：

```ts
interface SimulationResult {
  datasets: WaveformDataset[];
  activeDatasetId: string | null;
  preferredTraceIdsByDataset?: Record<string, string[]>;
}
```

前端只依赖 `SimulationResult` 和 `WaveformDataset`，不要让 UI 直接依赖 NGspice raw 文件格式。

## 编译和打包

环境要求：

- Node.js `>=20.17.0`
- npm
- 嘉立创 EDA 专业版 `>=3.3.0`

常用命令：

```bash
npm install
npx tsc --noEmit
npm run compile
npm run build
```

打包完成后输出位置：

```text
build/dist/simulation-with-ngspice_v1.2.1.eext
```

注意：当前 `build/packaged.ts` 会按 `extension.json.name` 和 `extension.json.version` 生成包名。

## 打包排除规则

由 `.edaignore` 控制，当前主要排除：

```text
/.git/
/.vscode/
/build/
/config/
/node_modules/
/src/
/package-lock.json
/package.json
/tsconfig.json
/CODEBASE_GUIDE.md
/NGSPICE_WASM_BUILD.md
/third_party/
/wasm-build/
/wasm-lib/
```

`.eext` 包中不会包含 `src/` 源码、构建脚本、third_party、wasm-build 或 wasm-lib，只包含编译后的 `dist/`、iframe 静态资源、WASM 运行资源、图片、根 README、CHANGELOG、LICENSE 和扩展清单。

## 调试建议

- 菜单打不开：看 `extension.json` 和 `src/index.ts`。
- EDA 仿真事件没进来：看 `registerSimulationEngineEvents()` 和宿主是否支持 `eda.sch_Event.addSimulationEnginePullEventListener`。
- iframe 没收到网表：看 `messages.ts` 的 topic 和 `src/iframe.ts` 的 `subscribeToEdaNetlist()`。
- 探针没有默认选中：看 `probeNodes` 是否进入 `NetlistImportMessage`，再看 `preferredTraceIdsByDataset()` 是否匹配到 trace。
- 电流探针没有曲线：确认网表中是否有 `XAM` 行，以及两端节点电压是否被 `.save` 并进入 raw。
- 仿真失败：看 `engine-runner.ts` 和 `wasm-ngspice-runner.ts`。
- raw 已生成但无曲线：看 raw 解析和 `ngspice-normalize.ts`。
- 曲线有数据但显示异常：看 `waveform-chart.ts`。

## 建议阅读顺序

1. `extension.json`
2. `src/index.ts`
3. `src/iframe.ts`
4. `src/shared/probes.ts`
5. `src/engine-runner.ts`
6. `src/wasm-ngspice-runner.ts`
7. `src/shared/types.ts`
8. `src/shared/waveform-chart.ts`
9. `iframe/styles.css`
