# 源码快速上手指南

本文用于理解 `NGspice 波形仿真` 临时版本的源码结构、运行流程和打包方式。当前扩展包名以 `extension.json` 为准：`simulation-with-ngspice`，版本为 `V1.2.1`。

## 项目定位

这是一个面向嘉立创 EDA 专业版的 NGspice 本地仿真与波形查看插件。当前临时版本已回退新 EDA 仿真事件 API 相关改动，不注册 `onStartupFinished` 仿真事件监听，也不接收 `probeNodes`。网表内的 `XAM` 电流探针处理保留。

插件主要做三件事：

- 通过原理图菜单导出当前 NGspice 仿真网表，或打开波形界面后手动导入 / 粘贴网表。
- 在 iframe 页面中用内置 NGspice WASM 在浏览器本地运行仿真。
- 将 transient、AC、DC 仿真结果解析为统一 `WaveformDataset`，再用 ECharts 绘制波形。

## 目录结构

```text
easyeda-ngspice-waveform-plugin/
├─ extension.json              # EDA 扩展清单，定义插件名、菜单、入口、版本等
├─ package.json                # Node 依赖和构建脚本
├─ README.md                   # 扩展详情页 README
├─ CHANGELOG.md                # 版本更新记录
├─ src/
│  ├─ index.ts                 # 插件主入口：菜单、iframe、MessageBus
│  ├─ iframe.ts                # 波形界面主逻辑：UI、导入、运行、日志、曲线选择
│  ├─ engine-runner.ts         # 仿真运行入口，目前只走内置 WASM
│  ├─ wasm-ngspice-runner.ts   # WASM 加载、运行、raw 文件解析
│  ├─ messages.ts              # 主入口和 iframe 之间的 MessageBus topic 与消息类型
│  └─ shared/
│     ├─ types.ts              # 波形数据结构定义
│     ├─ netlist.ts            # 网表识别、分析命令提取、AC 单位兼容
│     ├─ ngspice-normalize.ts  # 外部/旧协议波形消息归一化
│     ├─ probes.ts             # XAM 电流探针处理
│     └─ waveform-chart.ts     # ECharts 波形封装、缩放、拖拽、下采样、数值线模式
├─ iframe/
│  ├─ index.html               # iframe 页面壳
│  ├─ styles.css               # 波形界面样式
│  └─ wasm/                    # 实际打包进 .eext 的 NGspice WASM 运行资源
├─ config/                     # esbuild 配置
└─ build/packaged.ts           # 读取 .edaignore 并生成 .eext 包
```

## 关键入口

### `extension.json`

- `name`: `simulation-with-ngspice`
- `uuid`: `da6f02cde1cd4384abe56140588973be`
- `version`: `1.2.1`
- `activationEvents`: `{}`，不使用启动完成事件注册仿真监听
- `headerMenus.sch`: 原理图页面顶部菜单

菜单动作：

- `ImportSimulationNetlistToWaveform`: 导出当前仿真网表并打开波形界面。
- `OpenWaveformPanel`: 只打开波形界面，用户可手动导入或粘贴网表。

### `src/index.ts`

插件主入口，运行在 EDA 插件上下文中。

负责：

- `activate()`: 注册 MessageBus RPC。
- `openWaveformPanel()`: 打开 `/iframe/index.html` 波形窗口。
- `importSimulationNetlistToWaveform()`: 调用 EDA API 导出 NGspice 仿真网表，缓存为 `NetlistImportMessage` 并发布给 iframe。
- `publishLatestLater()`: 多次延迟发布最近一次网表，提升 iframe 首次打开时收到消息的稳定性。

关键 EDA API：

```ts
eda.sch_ManufactureData.getSimulationNetlistFile(...)
eda.sys_IFrame.openIFrame(...)
eda.sys_MessageBus.publishPublic(...)
eda.sys_MessageBus.rpcServicePublic(...)
```

### `src/iframe.ts`

波形界面主逻辑，运行在 `/iframe/index.html` 页面中。

负责：

- 渲染顶部工具栏、左侧网表编辑器、右侧波形图、底部日志、曲线选择弹窗。
- 接收主入口通过 MessageBus 发送的 `NetlistImportMessage`。
- 对同一份网表消息做 `netlistImportKey()` 去重，避免延迟重复广播在仿真完成后清空波形。
- 点击运行后调用 `runNgspiceNetlist(netlist)`。
- 仿真完成后通过 `queueTraceDialogOpen()` 延后打开曲线选择弹窗，减少首次运行时闪烁或波形不显示。

### `src/shared/waveform-chart.ts`

ECharts 波形封装。

负责：

- 波形渲染、图例隐藏、缩放、拖拽、下采样和坐标轴格式化。
- 数值线模式：
  - `跟随`: 鼠标移动时实时显示当前 x 位置数值。
  - `游标`: 游标线常驻画布，顶部红色三角手柄可拖动定位。

### `src/shared/probes.ts`

当前临时版本只保留网表内 `XAM` 电流探针相关逻辑：

- `augmentNetlistWithCurrentProbeSaves()`: 自动补充 `XAM` 两端电压 `.save`。
- `addSyntheticCurrentProbeTraces()`: 按 `(V(nodeA) - V(nodeB)) / 1e-3` 合成电流曲线。

## 运行流程

### 菜单导入流程

```text
用户点击原理图菜单
  -> src/index.ts 导出当前 NGspice 网表
  -> 缓存 NetlistImportMessage
  -> 打开 iframe
  -> MessageBus 延迟发布网表
  -> iframe 通过 netlistImportKey() 跳过重复消息
  -> 用户点击运行
  -> WASM 仿真并解析 raw
  -> 合成 XAM 电流曲线
  -> queueTraceDialogOpen() 延后打开曲线选择弹窗
  -> ECharts 渲染波形
```

### 手动网表流程

```text
用户点击打开波形界面
  -> iframe 打开空白界面
  -> 用户导入 / 粘贴网表
  -> 用户点击运行
  -> WASM 仿真并解析 raw
  -> 曲线选择和 ECharts 渲染
```

## 打包

```powershell
npm run build
```

输出：

```text
build/dist/simulation-with-ngspice_v1.2.1.eext
```

## 排查

- 菜单打不开：看 `extension.json` 和 `src/index.ts`。
- iframe 没收到网表：看 MessageBus RPC / publish 日志，以及 `netlistImportKey()` 是否跳过重复消息。
- 波形弹窗闪烁：看 `queueTraceDialogOpen()` 和重复网表广播是否被去重。
- 游标不显示：确认图表已有仿真结果，并且鼠标或点击位置在绘图区内。
