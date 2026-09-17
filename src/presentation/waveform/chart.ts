import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import { t } from "../../shared/i18n";
import type { WaveformAxis, WaveformDataset, WaveformTrace } from "../../shared/waveform";
import {
	axisDisplayUnit,
	axisMinInterval,
	clamp,
	constrainAxisView,
	escapeHtml,
	formatInspectionValue,
	formatInteger,
	labelForAnalysis,
	makeAxisLabelFormatter,
	readableAxisRange,
	formatWaveformValue,
} from "./axis-format";
import {
	downsamplePreserveExtremes,
	extent,
	interpolateSeriesValue,
	nearestSeriesPoint,
	nearestSeriesValue,
	windowedPoints,
} from "./series-data";
import {
	cloneView,
	computeView,
	constrainXView,
	fitXToDataBounds,
	initialCursorValue,
	panRange,
	zoomRange,
	type ViewState,
	type XBounds,
} from "./viewport";

type DisplayMode = "line" | "points" | "both";
type CursorMode = "follow" | "cursor";

interface RenderedTraceData {
  points: Array<[number, number]>;
  sourceCount: number;
}

interface InspectorRowElement {
  traceId: string;
  row: HTMLDivElement;
  swatch: HTMLSpanElement;
  value: HTMLSpanElement;
}

interface PanState {
  x: number;
  y: number;
  startedAt: number;
  bounds: { width: number; height: number };
  view: ViewState;
  dragging: boolean;
}

const displayLabelKeys: Record<DisplayMode, string> = {
  line: "display.line",
  points: "display.points",
  both: "display.both",
};

const cursorLabelKeys: Record<CursorMode, string> = {
  follow: "cursor.follow",
  cursor: "cursor.cursor",
};

const TARGET_POINTS_PER_PIXEL = 2.5;
const MIN_RENDER_POINTS = 1200;
const MAX_RENDER_POINTS = 12000;
/** 全部显示曲线的渲染点总预算，按曲线数均摊（条数多时每条自动缩点）。 */
const TOTAL_RENDER_POINTS_BUDGET = 300000;
const CURSOR_GRAPHIC_Z = 10000;
/** 自绘覆盖层（跟随线/圆点、游标线/手柄）的独立渲染层，避免更新时整层重绘曲线。 */
const OVERLAY_ZLEVEL = 100;
const CURSOR_LABEL_MAX_ROWS = 8;
export const TRACE_PALETTE = ["#1890ff", "#fa8c16", "#13a8a8", "#52c41a", "#6128ff", "#d73843", "#8c8c8c", "#096dd9"];
const TRACE_LEGEND_ICON = "path://M0 5 L20 5 L20 7 L0 7 Z M10 2 A4 4 0 1 0 10 10 A4 4 0 1 0 10 2 Z";
export function traceColorAt(index: number): string {
  return TRACE_PALETTE[Math.max(0, index) % TRACE_PALETTE.length];
}

/** 在共享时间向量上线性插值取值；超出范围钳到端点。 */
function mcInterpolateAt(time: Float64Array, values: Float32Array, x: number): number {
  const count = Math.min(time.length, values.length);
  if (!count) return Number.NaN;
  if (x <= time[0]) return values[0];
  if (x >= time[count - 1]) return values[count - 1];
  let lo = 0;
  let hi = count - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (time[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = time[hi] - time[lo];
  const fraction = span > 0 ? (x - time[lo]) / span : 0;
  return values[lo] + (values[hi] - values[lo]) * fraction;
}

/** 波形图的 ECharts 展示适配器。 */
export class WaveformChart {
  private chart: ECharts;
  private readonly inspectorEl: HTMLDivElement;
  private readonly inspectorAxisNameEl: HTMLSpanElement;
  private readonly inspectorInputEl: HTMLInputElement;
  private readonly inspectorUnitEl: HTMLSpanElement;
  private readonly inspectorRowsEl: HTMLDivElement;
  private inspectorXFactor = 1;
  private dataset: WaveformDataset | null = null;
  private displayMode: DisplayMode = "line";
  private cursorMode: CursorMode = "follow";
  private cursorX: number | null = null;
  private cursorDragging = false;
  /** 跟随模式鼠标所在 x（tooltip 数值用）。 */
  private hoverX: number | null = null;
  /** 跟随模式鼠标像素 x（覆盖层锚点）。 */
  private hoverPixelX: number | null = null;
  /** 跟随覆盖层 rAF 句柄。 */
  private followOverlayFrame: number | null = null;
  /** 覆盖层当前圆点个数（隐藏多余旧元素用）。 */
  private followDotCount = 0;
  /** 覆盖层是否已在画布上。 */
  private followOverlayVisible = false;
  private cursorUpdateFrame: number | null = null;
  private inspectorRowElements: InspectorRowElement[] = [];
  private visibleTraceIds: Set<string> | null = null;
  private highlightedTraceIds: Set<string> | null = null;
  private datasetXBounds: XBounds | null = null;
  /** 各 trace 实际渲染的点（窗口+降采样后），圆点/tooltip/游标都以它为准。 */
  private renderedPointsCache = new Map<string, Array<[number, number]>>();
  private legendHiddenTraceIds = new Set<string>();
  private panState: PanState | null = null;
  /** 每次渲染完成后通知的回调（叠加层取绘图区几何并重绘）。 */
  private readonly renderCallbacks = { onViewChange: new Set<() => void>() };
  private view: ViewState = {
    xMin: 0,
    xMax: 1,
    y: new Map<string, { min: number; max: number }>(),
  };

  constructor(
    private readonly el: HTMLElement,
    private readonly titleEl: HTMLElement,
    private readonly badgesEl: HTMLElement,
  ) {
    this.chart = echarts.init(el, null, { renderer: "canvas" });
    this.inspectorEl = document.createElement("div");
    this.inspectorEl.className = "waveform-inspector hidden";
    this.inspectorEl.innerHTML = `
      <div class="waveform-inspector-header">
        <span class="waveform-inspector-axis"></span>
        <input class="waveform-inspector-input" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="${escapeHtml(t("chart.inspectorAria"))}" />
        <span class="waveform-inspector-unit"></span>
      </div>
      <div class="waveform-inspector-rows"></div>
    `;
    this.inspectorAxisNameEl = this.inspectorEl.querySelector<HTMLSpanElement>(".waveform-inspector-axis") as HTMLSpanElement;
    this.inspectorInputEl = this.inspectorEl.querySelector<HTMLInputElement>(".waveform-inspector-input") as HTMLInputElement;
    this.inspectorUnitEl = this.inspectorEl.querySelector<HTMLSpanElement>(".waveform-inspector-unit") as HTMLSpanElement;
    this.inspectorRowsEl = this.inspectorEl.querySelector<HTMLDivElement>(".waveform-inspector-rows") as HTMLDivElement;
    this.el.appendChild(this.inspectorEl);
    this.installInspectorEvents();
    this.el.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    // 捕获阶段监听 mousemove：zrender（canvas 子元素，目标阶段）会在 el 冒泡处理前
    // 调用 tooltip formatter 读 hoverX，必须先于它更新，否则数值滞后一拍。
    this.el.addEventListener("mousemove", (event) => this.handleMouseMove(event), { capture: true });
    this.el.addEventListener("mouseleave", () => this.handleMouseLeave());
    this.el.addEventListener("mousedown", (event) => this.handleMouseDown(event));
    window.addEventListener("mousemove", (event) => this.handleWindowMouseMove(event));
    window.addEventListener("mouseup", (event) => this.handleWindowMouseUp(event));
    window.addEventListener("resize", () => this.resize());
    this.chart.on("legendselectchanged", (event: any) => this.handleLegendSelectionChanged(event));
    this.renderEmpty();
  }

  setDataset(dataset: WaveformDataset | null, opts?: { keepView?: boolean }) {
    const previousDatasetId = this.dataset?.id ?? null;
    this.dataset = dataset;
    this.datasetXBounds = null;
    this.renderedPointsCache.clear();
    this.panState = null;
    this.highlightedTraceIds = null;
    if (!dataset || dataset.id !== previousDatasetId) this.cursorX = null;
    if (!dataset) {
      this.renderEmpty();
      return;
    }
    this.legendHiddenTraceIds = new Set([...this.legendHiddenTraceIds].filter((id) => dataset.traces.some((trace) => trace.id === id)));
    // keepView：同一数据集的渐进更新（如 MC 实时叠加）保留用户当前视图，不重新适配。
    if (opts?.keepView && dataset.id === previousDatasetId) {
      this.render();
      return;
    }
    this.fit();
  }

  setVisibleTraceIds(ids: Iterable<string> | null, refit = true) {
    this.visibleTraceIds = ids ? new Set(ids) : null;
    this.legendHiddenTraceIds = new Set([...this.legendHiddenTraceIds].filter((id) => this.visibleTraceIds?.has(id) ?? true));
    if (!this.dataset) return;
    if (refit) {
      this.fit();
    } else {
      this.render();
    }
  }

  setHighlightedTraceIds(ids: Iterable<string> | null) {
    const next = ids ? new Set(ids) : null;
    this.highlightedTraceIds = next && next.size ? next : null;
    if (this.dataset) this.render();
  }

  fit() {
    if (!this.dataset) return;
    const traces = this.getDisplayedTraces();
    if (!traces.length) {
      this.render();
      return;
    }
    this.view = computeView(this.dataset, traces);
    this.view = {
      ...this.view,
      ...fitXToDataBounds(this.dataset, traces),
    };
    this.render();
  }

  resize() {
    this.chart.resize();
    this.restoreCursorAfterRender();
    this.scheduleFollowOverlay();
    // resize 时 ECharts 自行重绘，不走 render()——同样通知叠加画布同步几何。
    this.renderCallbacks.onViewChange.forEach((callback) => callback());
  }

  refreshLocale() {
    this.inspectorInputEl.setAttribute("aria-label", t("chart.inspectorAria"));
    if (this.dataset) this.render();
    else this.renderEmpty();
  }

  cycleDisplayMode(): string {
    const modes: DisplayMode[] = ["line", "points", "both"];
    const index = modes.indexOf(this.displayMode);
    this.displayMode = modes[(index + 1) % modes.length];
    this.render();
    return t(displayLabelKeys[this.displayMode]);
  }

  getDisplayLabel(): string {
    return t(displayLabelKeys[this.displayMode]);
  }

  /** 当前显示模式（叠加画布同步用）。 */
  getDisplayMode(): DisplayMode {
    return this.displayMode;
  }

  cycleCursorMode(): string {
    this.cursorMode = this.cursorMode === "follow" ? "cursor" : "follow";
    if (this.cursorMode === "cursor") {
      this.ensureCursorPosition();
    } else {
      this.hideCursorMarkers();
    }
    this.render();
    if (this.cursorMode === "cursor") this.updateCursorAtX();
    return t(cursorLabelKeys[this.cursorMode]);
  }

  getCursorModeLabel(): string {
    return t(cursorLabelKeys[this.cursorMode]);
  }

  private renderEmpty() {
    this.hideInspector();
    this.titleEl.textContent = t("chart.waveformTitle");
    this.badgesEl.innerHTML = `<span class="chart-meta">${escapeHtml(t("chart.waiting"))}</span>`;
    this.chart.setOption({
      backgroundColor: "#f7f8fa",
      xAxis: { show: false },
      yAxis: { show: false },
      series: [],
      graphic: {
        type: "text",
        left: "center",
        top: "middle",
        style: {
          text: t("chart.emptyHint"),
          fill: "#868686",
          font: "12px Microsoft YaHei",
        },
      },
    } satisfies EChartsOption, true);
  }

  /** 渲染出错时的占位提示，避免界面停在异常状态。 */
  private renderRenderError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    this.hideInspector();
    this.titleEl.textContent = t("chart.waveformTitle");
    this.badgesEl.innerHTML = `<span class="chart-meta">${escapeHtml(t("chart.renderError"))}</span>`;
    this.chart.setOption({
      backgroundColor: "#f7f8fa",
      xAxis: { show: false },
      yAxis: { show: false },
      series: [],
      graphic: {
        type: "text",
        left: "center",
        top: "middle",
        style: {
          text: `${t("chart.renderError")}: ${escapeHtml(message)}`,
          fill: "#d32029",
          font: "12px Microsoft YaHei",
        },
      },
    } satisfies EChartsOption, true);
  }

  private render() {
    if (!this.dataset) return;
    try {
      this.renderChart();
      // 绘图区几何/视图变化后通知叠加层（如 MC 立即模式画布）。
      this.renderCallbacks.onViewChange.forEach((callback) => callback());
    }
    catch (error) {
      this.renderRenderError(error);
    }
  }

  /** 注册渲染后回调（叠加层用：获取绘图区几何并整体重绘）。返回取消函数。 */
  onAfterRender(callback: () => void): () => void {
    this.renderCallbacks.onViewChange.add(callback);
    return () => this.renderCallbacks.onViewChange.delete(callback);
  }

  /** 当前绘图区像素矩形 + 数据范围（供叠加层对齐 ECharts 坐标）。 */
  getPlotGeometry() {
    if (!this.dataset) return null;
    const bounds = this.plotBounds();
    const xAxis = this.dataset.xAxis;
    const yAxis = this.getRenderableAxes()[0];
    const yRange = yAxis ? this.view.y.get(yAxis.id) : null;
    if (!yRange) return null;
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      xMin: this.view.xMin,
      xMax: this.view.xMax,
      xLog: xAxis.scale === "log",
      yMin: yRange.min,
      yMax: yRange.max,
      yLog: yAxis.scale === "log",
    };
  }

  private renderChart() {
    if (!this.dataset) return;
    if (this.cursorMode === "cursor") this.ensureCursorPosition();
    const dataset = this.dataset;
    const visibleTraces = this.getVisibleTraces();
    const yAxes = this.getRenderableAxes();
    const yAxisRanges = this.getRenderableYAxisRanges(yAxes);
    const visibleColors = visibleTraces.map((trace, index) => this.colorForTrace(trace, index));

    this.titleEl.textContent = dataset.title;
    // MC scaffold：ECharts 只承载隐形极值线，分析类型/命令/曲线数徽标无意义，仅显示样本概况。
    const isMcScaffold = dataset.id === "mc-scaffold";
    const badgeItems = isMcScaffold
      ? [dataset.meta.sourcePlot ? escapeHtml(dataset.meta.sourcePlot) : "Monte Carlo"]
      : [
        labelForAnalysis(dataset.spiceCommandType),
        dataset.command ? escapeHtml(dataset.command) : "",
        t("chart.traceCount", visibleTraces.filter((trace) => !trace.name.startsWith("__")).length, dataset.traces.filter((trace) => !trace.name.startsWith("__")).length),
        t("chart.pointCount", formatInteger(visibleTraces.reduce((sum, trace) => sum + trace.points.length, 0))),
      ];
    this.badgesEl.innerHTML = `<span class="chart-meta">${badgeItems.filter(Boolean).join(" · ")}</span>`;
    this.el.title = this.cursorMode === "follow"
      ? t("chart.followHelp")
      : t("chart.cursorHelp");

    const showEmptyHint = visibleTraces.length === 0;
    const option: EChartsOption = {
      color: visibleColors,
      backgroundColor: createWatermarkPattern() as any,
      // 关闭动画，保证折线与游标/圆点同帧更新。
      animation: false,
      tooltip: {
        show: this.cursorMode === "follow",
        trigger: "axis",
        confine: true,
        enterable: false,
        backgroundColor: "#fff",
        borderColor: "#d9d9d9",
        borderWidth: 1,
        textStyle: { color: "#333", fontSize: 12 },
        axisPointer: {
          // 竖线自绘（见 renderFollowOverlay），关闭 ECharts 的轴指针。
          type: "none",
          snap: false,
        },
        formatter: (params) => this.isMonteCarloDataset()
          ? this.formatMcStatsTooltip()
          : this.formatTooltip(Array.isArray(params) ? params : [params]),
      },
      legend: {
        top: 0,
        type: "scroll",
        itemWidth: 20,
        itemHeight: 12,
        data: visibleTraces.filter((trace) => !trace.name.startsWith("__")).map((trace) => ({ name: trace.name, icon: TRACE_LEGEND_ICON })),
        selected: Object.fromEntries(visibleTraces.map((trace) => [trace.name, !this.legendHiddenTraceIds.has(trace.id)])),
        textStyle: { fontSize: 12, color: "#333" },
      },
      grid: {
        show: true,
        top: 46,
        left: 76,
        right: yAxes.length > 1 ? 76 : 32,
        bottom: 54,
        containLabel: false,
        borderColor: "#b8c0cc",
        borderWidth: 1,
      },
      xAxis: {
        type: dataset.xAxis.scale === "log" ? "log" : "value",
        scale: true,
        logBase: 10,
        min: this.view.xMin,
        max: this.view.xMax,
        minInterval: axisMinInterval(dataset.xAxis.unit, dataset.xAxis.scale, this.view.xMin, this.view.xMax),
        name: `${dataset.xAxis.name}${dataset.xAxis.unit ? ` (${dataset.xAxis.unit})` : ""}`,
        nameLocation: "middle",
        nameGap: 30,
        nameTextStyle: { color: "#868686", fontSize: 12 },
        axisLabel: {
          color: "#5f6874",
          hideOverlap: true,
          formatter: makeAxisLabelFormatter(dataset.xAxis.unit, dataset.xAxis.scale, this.view.xMin, this.view.xMax),
        },
        axisLine: { onZero: false, lineStyle: { color: "#87909e" } },
        splitLine: { show: true, lineStyle: { color: "#dde2e8" } },
        splitNumber: 5,
        minorTick: { show: dataset.xAxis.scale !== "log" },
        minorSplitLine: { show: dataset.xAxis.scale !== "log", lineStyle: { color: "#edf0f4" } },
      },
      yAxis: yAxes.map((axis, index) => this.buildYAxisConfig(axis, index, yAxisRanges)),
      series: [
        ...visibleTraces.map((trace, index) => this.buildTraceSeries(trace, index, yAxes)),
        ...yAxes.map((axis) => this.buildCursorSeries(axis)),
      ],
      graphic: showEmptyHint
        ? {
            type: "text",
            left: "center",
            top: "middle",
            style: {
              text: t("chart.noTraceSelected"),
              fill: "#868686",
              font: "12px Microsoft YaHei",
            },
          }
        : undefined,
    };

    this.chart.setOption(option, true);
    this.restoreCursorAfterRender();
    // notMerge 重绘会清掉覆盖层 graphic，重建。
    this.scheduleFollowOverlay();
  }

  private restoreCursorAfterRender() {
    if (!this.dataset || this.cursorMode !== "cursor") {
      this.hideInspector();
      return;
    }
    this.ensureCursorPosition();
    if (this.cursorX === null) return;
    // 缩放后游标可能落到视野外，clamp 回视野再 snap。
    this.cursorX = this.snapXToSamples(clamp(this.cursorX, this.view.xMin, this.view.xMax));
    this.updateCursorAtX();
  }

  /** 单根 y 轴完整配置。数字逻辑轴走 category，其余走 value。 */
  private buildYAxisConfig(
    axis: WaveformAxis,
    index: number,
    yAxisRanges: Map<string, { min: number; max: number }>,
  ) {
    const range = yAxisRanges.get(axis.id);
    return {
      type: axis.scale === "log" ? ("log" as const) : ("value" as const),
      scale: true,
      position: index === 0 ? "left" as const : "right" as const,
      offset: 0,
      min: range?.min,
      max: range?.max,
      minInterval: axisMinInterval(axis.unit, axis.scale, range?.min, range?.max),
      splitNumber: 4,
      name: `${axis.name}${axis.unit ? ` (${axis.unit})` : ""}`,
      nameLocation: "end" as const,
      nameGap: 12,
      nameTextStyle: {
        color: "#868686",
        fontSize: 12,
        align: index === 0 ? ("right" as const) : ("left" as const),
      },
      axisLabel: {
        color: "#5f6874",
        hideOverlap: false,
        margin: 8,
        width: 62,
        overflow: "truncate" as const,
        align: index === 0 ? ("right" as const) : ("left" as const),
        formatter: makeAxisLabelFormatter(axis.unit, axis.scale, range?.min, range?.max),
      },
      axisLine: { show: true, onZero: false, lineStyle: { color: "#87909e" } },
      splitLine: { show: index === 0, lineStyle: { color: "#dde2e8" } },
      minorTick: { show: axis.scale !== "log" },
      minorSplitLine: { show: index === 0 && axis.scale !== "log", lineStyle: { color: "#edf0f4" } },
    };
  }

  /**
   * 增量更新用的 y 轴字段：只更新范围，按数组位置合并。
   * 注意：不能带 axisIndex/id 等身份字段——ECharts 会把它们当成追加新轴，
   * 导致缩放后右侧冒出错位的分度值。
   */
  private buildYAxisViewUpdate(
    axis: WaveformAxis,
    _index: number,
    yAxisRanges: Map<string, { min: number; max: number }>,
  ) {
    const range = yAxisRanges.get(axis.id);
    return {
      min: range?.min,
      max: range?.max,
      minInterval: axisMinInterval(axis.unit, axis.scale, range?.min, range?.max),
      axisLabel: {
        formatter: makeAxisLabelFormatter(axis.unit, axis.scale, range?.min, range?.max),
      },
    };
  }

  private buildTraceSeries(trace: WaveformTrace, index: number, yAxes: WaveformAxis[]) {
    const axisIndex = Math.max(0, yAxes.findIndex((axis) => axis.id === trace.axisId));
    const showLine = this.displayMode !== "points";
    const rendered = this.renderTraceData(trace);
    const showPoints = this.displayMode !== "line" && rendered.points.length <= 6000;
    const color = this.colorForTrace(trace, index);
    const highlighted = this.highlightedTraceIds?.has(trace.id) ?? false;
    const dimmed = Boolean(this.highlightedTraceIds?.size) && !highlighted;
    return {
      id: trace.id,
      name: trace.name,
      type: "line" as const,
      yAxisIndex: axisIndex,
      data: rendered.points,
      symbol: "circle",
      showSymbol: showPoints,
      symbolSize: showPoints ? 3.5 : 6,
      smooth: false,
      sampling: undefined,
      // 渲染点已按画布宽降采样，无需 large/progressive 分帧。
      lineStyle: {
        color,
        width: showLine ? highlighted ? 2.6 : 1.4 : 0,
        opacity: showLine ? dimmed ? 0.16 : 1 : 0,
      },
      itemStyle: { color, opacity: dimmed ? 0.24 : 1 },
      z: highlighted ? 12 : 2,
      // 坐标轴 tooltip 可能同时强调全部 Monte Carlo 曲线，因此保持 hover 样式中性，
      // 让样本表格高亮成为唯一的曲线淡化规则。
      emphasis: { disabled: true },
    };
  }

  private buildTraceSeriesViewUpdate(trace: WaveformTrace) {
    const rendered = this.renderTraceData(trace);
    const showPoints = this.displayMode !== "line" && rendered.points.length <= 6000;
    return {
      id: trace.id,
      data: rendered.points,
      showSymbol: showPoints,
      symbolSize: showPoints ? 3.5 : 6,
    };
  }

  private renderTraceData(trace: WaveformTrace): RenderedTraceData {
    const points = windowedPoints(trace.points, this.view.xMin, this.view.xMax);
    const maxPoints = this.maxRenderPoints();
    const rendered = points.length <= maxPoints
      ? points
      : downsamplePreserveExtremes(points, maxPoints);
    this.renderedPointsCache.set(trace.id, rendered);
    return { points: rendered, sourceCount: points.length };
  }

  /** trace 当前渲染点（渲染先于交互，未命中时回退原始点）。 */
  private getRenderedPoints(trace: WaveformTrace): Array<[number, number]> {
    return this.renderedPointsCache.get(trace.id) ?? trace.points;
  }

  private maxRenderPoints(): number {
    const width = this.plotBounds().width || this.el.clientWidth || 480;
    const perTrace = Math.floor(width * TARGET_POINTS_PER_PIXEL);
    const traceCount = Math.max(1, this.getVisibleTraces().length);
    const shared = Math.floor(TOTAL_RENDER_POINTS_BUDGET / traceCount);
    return clamp(Math.min(perTrace, Math.max(shared, MIN_RENDER_POINTS)), MIN_RENDER_POINTS, MAX_RENDER_POINTS);
  }

  private buildCursorSeries(axis: WaveformAxis) {
    const yAxes = this.getRenderableAxes();
    const axisIndex = Math.max(0, yAxes.findIndex((item) => item.id === axis.id));
    return {
      id: `cursor_axis_${axis.id}`,
      name: `__cursor_${axis.id}`,
      type: "scatter" as const,
      yAxisIndex: axisIndex,
      data: [],
      symbol: "circle",
      symbolSize: 8,
      z: 20,
      silent: true,
      animation: false,
      itemStyle: {
        borderColor: "#ffffff",
        borderWidth: 1.5,
      },
      tooltip: { show: false },
    };
  }

  /** MC：x 处全部样本插值值的 min/P50/max（画布圆点与统计 tooltip 同源）。 */
  private mcStatsAt(x: number): { min: number; p50: number; max: number } | null {
    const dataset = this.dataset;
    if (!dataset) return null;
    const store = dataset.meta.waveformStore as {
      getSeries(traceName: string): Array<{ time: Float64Array; values: Float32Array }>;
    } | undefined;
    const traceName = dataset.meta.probeTraceName as string | undefined;
    if (!store || !traceName) return null;
    const seriesList = store.getSeries(traceName);
    if (!seriesList.length) return null;
    const gathered: number[] = [];
    for (const series of seriesList) {
      const value = mcInterpolateAt(series.time, series.values, x);
      if (Number.isFinite(value)) gathered.push(value);
    }
    if (!gathered.length) return null;
    gathered.sort((a, b) => a - b);
    return {
      min: gathered[0],
      p50: gathered[Math.floor((gathered.length - 1) / 2)],
      max: gathered[gathered.length - 1],
    };
  }

  /** MC 跟随读数 */
  private formatMcStatsTooltip(): string {
    const dataset = this.dataset;
    if (!dataset) return "";
    const mouseX = this.hoverX;
    if (mouseX === null || !Number.isFinite(mouseX)) return "";
    // 与竖线一致：点/线点模式吸附到最近采样时刻，线模式跟随鼠标。
    const mouseXsnapped = this.displayMode !== "line" ? this.snapXToSamples(mouseX) : mouseX;
    const unit = dataset.yAxes[0]?.unit ?? "";
    const fmt = (value: number) => formatInspectionValue(value, unit, this.view.xMin, this.view.xMax);
    const xLabel = `${escapeHtml(dataset.xAxis.name)}: ${formatInspectionValue(mouseXsnapped, dataset.xAxis.unit, this.view.xMin, this.view.xMax)}`;
    // 有高亮样本：单行显示该样本在当前时刻的插值值（颜色与样本线一致）。
    const highlightIndex = dataset.meta.highlightSampleIndex;
    if (highlightIndex !== undefined && highlightIndex !== null) {
      const store = dataset.meta.waveformStore as {
        getSeries(traceName: string): Array<{ sampleIndex: number; time: Float64Array; values: Float32Array }>;
      } | undefined;
      const traceName = dataset.meta.probeTraceName as string | undefined;
      const series = traceName ? store?.getSeries(traceName).find((item) => item.sampleIndex === highlightIndex) : undefined;
      if (!series) return "";
      const value = mcInterpolateAt(series.time, series.values, mouseXsnapped);
      const hue = (highlightIndex * 137.508) % 360;
      const marker = `<span style="display:inline-block;width:10px;height:2px;vertical-align:middle;background:hsl(${hue.toFixed(1)} 72% 46%);margin-right:4px"></span>`;
      return `<div class="chart-tip"><b>${xLabel}</b><br/>${marker}#${highlightIndex}: ${fmt(value)}</div>`;
    }
    const stats = this.mcStatsAt(mouseXsnapped);
    if (!stats) return "";
    return `<div class="chart-tip"><b>${xLabel}</b><br/>`
      + `min: ${fmt(stats.min)}<br/>P50: ${fmt(stats.p50)}<br/>max: ${fmt(stats.max)}</div>`;
  }

  private formatTooltip(_params: Array<Record<string, any>>): string {
    if (!this.dataset) return "";
    // 数值与覆盖层同源：都从 hoverX 出发，不用 ECharts 的 snap axisValue。
    const mouseX = this.hoverX;
    if (mouseX === null || !Number.isFinite(mouseX)) return "";
    const snap = this.displayMode !== "line";
    const x = snap ? this.snapXToSamples(mouseX) : mouseX;

    let html = `<div class="chart-tip"><b>${escapeHtml(this.dataset.xAxis.name)}: ${formatInspectionValue(
      x,
      this.dataset.xAxis.unit,
      this.view.xMin,
      this.view.xMax,
    )}</b><br/>`;
    const rows: Array<{ marker: string; name: string; value: number | null; unit: string }> = [];
    for (const trace of this.getInspectionTraces()) {
      if (rows.length >= CURSOR_LABEL_MAX_ROWS) break;
      const rendered = this.getRenderedPoints(trace);
      let value: number | null;
      if (snap) {
        const point = nearestSeriesPoint(rendered, mouseX);
        value = point ? point[1] : null;
      }
      else {
        value = interpolateSeriesValue(rendered, x);
      }
      rows.push({
        marker: trace.color ? `<span style="display:inline-block;width:10px;height:2px;vertical-align:middle;background:${trace.color};margin-right:4px"></span>` : "",
        name: trace.name,
        value,
        unit: trace.unit,
      });
    }
    const visible = rows.filter((row) => row.value !== null);
    for (const row of visible) {
      html += `${row.marker}${escapeHtml(row.name)}: ${formatInspectionValue(row.value as number, row.unit)}<br/>`;
    }
    const hiddenCount = rows.length - visible.length;
    if (hiddenCount > 0) {
      html += `<span style="color:#868686">${escapeHtml(t("chart.hiddenTraces", hiddenCount))}</span><br/>`;
    }
    return visible.length ? `${html}</div>` : "";
  }

  private handleWheel(event: WheelEvent) {
    if (!this.dataset) return;
    const bounds = this.el.getBoundingClientRect();
    const localX = event.clientX - bounds.left;
    const localY = event.clientY - bounds.top;
    const yAxes = this.getRenderableAxes();
    const isPlotPoint = this.isInPlot(localX, localY);
    const region = localX < 84 ? "left-y" : localX > bounds.width - 84 && yAxes.length > 1 ? "right-y" : "x";
    const scale = event.deltaY < 0 ? 0.84 : 1.16;
    event.preventDefault();

    if (isPlotPoint) {
      const focusX = this.xValueAtPixel(localX, localY);
      const next = constrainXView(zoomRange(this.view.xMin, this.view.xMax, focusX, scale, this.dataset.xAxis.scale === "log"), this.getXBounds());
      this.view.xMin = next.min;
      this.view.xMax = next.max;
    } else {
      if (region === "x") {
        const focusX = this.xValueAtPixel(localX, localY);
        const next = constrainXView(zoomRange(this.view.xMin, this.view.xMax, focusX, scale, this.dataset.xAxis.scale === "log"), this.getXBounds());
        this.view.xMin = next.min;
        this.view.xMax = next.max;
      } else {
        const axisIndex = region === "right-y" ? 1 : 0;
        const axis = yAxes[axisIndex];
        const current = this.view.y.get(axis.id);
        if (current) {
          const focusY = this.yValueAtPixel(axisIndex, localX, localY);
          this.view.y.set(axis.id, constrainAxisView(zoomRange(current.min, current.max, focusY, scale, axis.scale === "log"), axis.unit, axis.scale));
        }
      }
    }

    this.applyView();
  }

  private handleMouseMove(event: MouseEvent) {
    if (!this.dataset || this.panState || this.cursorDragging) return;
    const point = this.localPoint(event);
    if (this.cursorMode === "cursor" && this.isCursorHandleHit(point.x, point.y)) {
      this.el.style.cursor = "ew-resize";
      return;
    }
    if (!this.isInPlot(point.x, point.y)) {
      this.el.style.cursor = "default";
      this.hoverX = null;
      this.hoverPixelX = null;
      this.clearFollowOverlay();
      return;
    }
    // 记录鼠标像素 x 作为覆盖层锚点，tooltip 数值同源。
    this.hoverPixelX = point.x;
    this.hoverX = this.xValueFromPixel(point.x);
    this.scheduleFollowOverlay();
    this.el.style.cursor = this.cursorMode === "cursor"
      ? this.isCursorHandleHit(point.x, point.y) ? "ew-resize" : "default"
      : "grab";
  }

  /** 跟随覆盖层（竖线 + 交点圆点）rAF 合帧重画。 */
  private scheduleFollowOverlay(): void {
    if (this.followOverlayFrame !== null) return;
    this.followOverlayFrame = requestAnimationFrame(() => {
      this.followOverlayFrame = null;
      this.renderFollowOverlay();
    });
  }

  /** 像素 x → 数据 x（ECharts 坐标反变换）。 */
  private xValueFromPixel(pixelX: number): number {
    const value = this.chart.convertFromPixel({ xAxisIndex: 0 }, pixelX);
    return Array.isArray(value) ? Number(value[0]) : Number(value);
  }

  /** 轴仿射映射（数据 → 像素）：两点定标，点查询 O(1)。log 轴在 log10 空间线性。 */
  private buildPixelMapper(
    axisFinder: { xAxisIndex: number } | { yAxisIndex: number },
    min: number,
    max: number,
    isLog: boolean,
  ): ((value: number) => number) | null {
    const toDomain = isLog ? (v: number) => Math.log10(Math.max(v, Number.MIN_VALUE)) : (v: number) => v;
    const p1 = normalizePixel(this.chart.convertToPixel(axisFinder as any, min), 0);
    const p2 = normalizePixel(this.chart.convertToPixel(axisFinder as any, max), 0);
    const d1 = toDomain(min);
    const d2 = toDomain(max);
    if (!Number.isFinite(p1) || !Number.isFinite(p2) || d2 === d1) return null;
    const scale = (p2 - p1) / (d2 - d1);
    return (value: number) => p1 + (toDomain(value) - d1) * scale;
  }

  /** MC 叠加数据集曲线过多：禁用逐线数值显示（tooltip/圆点/标签），只保留跟随竖线。 */
  private isMonteCarloDataset(): boolean {
    return this.dataset?.productAnalysisType === "monte-carlo";
  }

  private renderFollowOverlay(): void {
    if (this.cursorMode !== "follow" || !this.dataset || this.hoverPixelX === null) {
      this.clearFollowOverlay();
      return;
    }
    const bounds = this.plotBounds();
    const mousePixelX = clamp(this.hoverPixelX, bounds.left, bounds.right);
    this.hoverX = this.xValueFromPixel(mousePixelX);
    const snap = this.displayMode !== "line";
    // 点/线点模式竖线跳最近采样点，线模式贴鼠标。
    const lineX = snap ? this.snapXToSamples(this.hoverX) : this.hoverX;
    const xToPixel = this.buildPixelMapper({ xAxisIndex: 0 }, this.view.xMin, this.view.xMax, this.dataset.xAxis.scale === "log");
    if (!xToPixel) {
      this.clearFollowOverlay();
      return;
    }
    const linePixelX = xToPixel(lineX);
    if (!Number.isFinite(linePixelX)) {
      this.clearFollowOverlay();
      return;
    }
    const graphics: any[] = [{
      id: "hover-follow-line",
      type: "line",
      silent: true,
      z: CURSOR_GRAPHIC_Z,
      zlevel: OVERLAY_ZLEVEL,
      // 合并更新按字段存在性取值，invisible 必须显式写。
      invisible: false,
      shape: { x1: linePixelX, y1: bounds.top, x2: linePixelX, y2: bounds.bottom },
      style: { stroke: "rgba(0,0,0,0.24)", lineWidth: 1, lineDash: [5, 4] },
    }];
    if (this.isMonteCarloDataset()) {
      // MC 叠加图：竖线 + 该时刻 min/P50/max 三个交点圆点（与统计 tooltip 同源）。
      const mcStats = this.mcStatsAt(lineX);
      const mcYAxes = this.getRenderableAxes();
      const mcYRange = mcYAxes[0] ? this.view.y.get(mcYAxes[0].id) : null;
      const mcYToPixel = mcYRange ? this.buildPixelMapper({ yAxisIndex: 0 }, mcYRange.min, mcYRange.max, mcYAxes[0].scale === "log") : null;
      let mcDotIndex = 0;
      const mcHighlight = this.dataset.meta.highlightSampleIndex;
      const mcStore = this.dataset.meta.waveformStore as {
        getSeries(traceName: string): Array<{ sampleIndex: number; time: Float64Array; values: Float32Array }>;
      } | undefined;
      const mcTraceName = this.dataset.meta.probeTraceName as string | undefined;
      if (mcHighlight !== undefined && mcHighlight !== null && mcStore && mcTraceName && mcYToPixel) {
        // 高亮样本：单交点圆点（该样本在当前时刻的插值值，颜色与样本线一致）。
        const series = mcStore.getSeries(mcTraceName).find((item) => item.sampleIndex === mcHighlight);
        if (series) {
          const value = mcInterpolateAt(series.time, series.values, lineX);
          const py = mcYToPixel(value);
          if (Number.isFinite(py) && py >= bounds.top && py <= bounds.bottom) {
            const hue = (mcHighlight * 137.508) % 360;
            graphics.push({
              id: "hover-follow-dot-0",
              type: "circle",
              silent: true,
              z: CURSOR_GRAPHIC_Z + 1,
              zlevel: OVERLAY_ZLEVEL,
              invisible: false,
              shape: { cx: linePixelX, cy: py, r: 4 },
              style: { fill: `hsl(${hue.toFixed(1)} 72% 46%)`, stroke: "#ffffff", lineWidth: 1.5 },
            });
            mcDotIndex = 1;
          }
        }
      }
      else if (mcStats && mcYToPixel) {
        const dots: Array<{ value: number; color: string; r: number }> = [
          { value: mcStats.min, color: "#8c8c8c", r: 3 },
          { value: mcStats.p50, color: "#d4380d", r: 4 },
          { value: mcStats.max, color: "#8c8c8c", r: 3 },
        ];
        for (const dot of dots) {
          const py = mcYToPixel(dot.value);
          if (!Number.isFinite(py) || py < bounds.top || py > bounds.bottom) continue;
          graphics.push({
            id: `hover-follow-dot-${mcDotIndex}`,
            type: "circle",
            silent: true,
            z: CURSOR_GRAPHIC_Z + 1,
            zlevel: OVERLAY_ZLEVEL,
            invisible: false,
            shape: { cx: linePixelX, cy: py, r: dot.r },
            style: { fill: dot.color, stroke: "#ffffff", lineWidth: 1.5 },
          });
          mcDotIndex += 1;
        }
      }
      for (let index = mcDotIndex; index < this.followDotCount; index += 1) {
        graphics.push({ id: `hover-follow-dot-${index}`, type: "circle", invisible: true, silent: true });
      }
      this.followDotCount = mcDotIndex;
      this.followOverlayVisible = true;
      this.chart.setOption({ graphic: graphics }, false);
      return;
    }
    // 交点圆点：数据空间求值（线模式插值 / 点模式最近采样点），仿射映射到像素。
    const yAxes = this.getRenderableAxes();
    const yRanges = this.getRenderableYAxisRanges(yAxes);
    const yMappers = yAxes.map((axis, index) => {
      const range = yRanges.get(axis.id);
      return range ? this.buildPixelMapper({ yAxisIndex: index }, range.min, range.max, axis.scale === "log") : null;
    });
    const traces = this.getInspectionTraces();
    let dotCount = 0;
    for (const [traceIndex, trace] of traces.entries()) {
      const axisIndex = yAxes.findIndex((axis) => axis.id === trace.axisId);
      const yToPixel = axisIndex >= 0 ? yMappers[axisIndex] : null;
      if (!yToPixel) continue;
      const rendered = this.getRenderedPoints(trace);
      let point: [number, number] | null = null;
      if (snap) point = nearestSeriesPoint(rendered, this.hoverX);
      else {
        const y = interpolateSeriesValue(rendered, this.hoverX);
        if (y !== null) point = [this.hoverX, y];
      }
      if (!point) continue;
      const dotX = xToPixel(point[0]);
      const dotY = yToPixel(point[1]);
      // 圆点超出绘图区（曲线 y 在视野外/采样点在视野边缘）直接不画，防止溢出表格。
      if (!Number.isFinite(dotX) || !Number.isFinite(dotY)) continue;
      if (dotX < bounds.left || dotX > bounds.right || dotY < bounds.top || dotY > bounds.bottom) continue;
      graphics.push({
        id: `hover-follow-dot-${dotCount}`,
        type: "circle",
        silent: true,
        z: CURSOR_GRAPHIC_Z + 1,
        zlevel: OVERLAY_ZLEVEL,
        invisible: false,
        shape: { cx: dotX, cy: dotY, r: 4 },
        style: { fill: this.colorForTrace(trace, traceIndex), stroke: "#ffffff", lineWidth: 1.5 },
      });
      dotCount += 1;
    }
    // 隐藏上一帧多画的圆点。
    for (let index = dotCount; index < this.followDotCount; index += 1) {
      graphics.push({ id: `hover-follow-dot-${index}`, type: "circle", invisible: true, silent: true });
    }
    this.followDotCount = dotCount;
    this.followOverlayVisible = true;
    this.chart.setOption({ graphic: graphics }, false);
  }

  /** 清掉跟随覆盖层（竖线 + 圆点）。 */
  private clearFollowOverlay(): void {
    if (this.followOverlayFrame !== null) {
      cancelAnimationFrame(this.followOverlayFrame);
      this.followOverlayFrame = null;
    }
    if (!this.followOverlayVisible) return;
    const graphics: any[] = [
      { id: "hover-follow-line", type: "line", invisible: true, silent: true, shape: { x1: 0, y1: 0, x2: 0, y2: 0 } },
    ];
    for (let index = 0; index < this.followDotCount; index += 1) {
      graphics.push({ id: `hover-follow-dot-${index}`, type: "circle", invisible: true, silent: true });
    }
    this.chart.setOption({ graphic: graphics }, false);
    this.followDotCount = 0;
    this.followOverlayVisible = false;
  }

  private handleMouseLeave() {
    if (!this.panState && !this.cursorDragging) this.el.style.cursor = "default";
    this.hoverX = null;
    this.hoverPixelX = null;
    this.clearFollowOverlay();
  }

  private handleMouseDown(event: MouseEvent) {
    if (!this.dataset || event.button !== 0) return;
    const point = this.localPoint(event);
    if (this.cursorMode === "cursor") {
      // 命中三角形手柄：进入拖动。
      if (this.isCursorHandleHit(point.x, point.y)) {
        this.cursorDragging = true;
        this.el.style.cursor = "ew-resize";
        event.preventDefault();
        return;
      }
      // 点击画布其它位置：游标直接跳到该 x（与逻辑图一致）。
      if (this.isInPlot(point.x, point.y)) {
        this.updateCursorFromLocalPoint(point.x, point.y);
        event.preventDefault();
      }
      return;
    }
    if (!this.isInPlot(point.x, point.y)) return;
    const bounds = this.plotBounds();
    this.panState = {
      x: point.x,
      y: point.y,
      startedAt: performance.now(),
      bounds: { width: bounds.width, height: bounds.height },
      view: cloneView(this.view),
      dragging: false,
    };
    event.preventDefault();
  }

  private handleWindowMouseMove(event: MouseEvent) {
    if (this.dataset && this.cursorDragging && event.buttons === 1) {
      const point = this.localPoint(event);
      this.updateCursorFromLocalX(point.x);
      return;
    }
    if (!this.dataset || !this.panState || event.buttons !== 1) return;
    const point = this.localPoint(event);
    // 平移时同步像素锚点，覆盖层才能钉在鼠标下。
    this.hoverPixelX = point.x;
    const dx = point.x - this.panState.x;
    const dy = point.y - this.panState.y;
    const distance = Math.hypot(dx, dy);
    if (!this.panState.dragging && performance.now() - this.panState.startedAt < 120 && distance < 3) return;

    this.panState.dragging = true;
    this.el.style.cursor = "grabbing";
    const xRange = constrainXView(panRange(this.panState.view.xMin, this.panState.view.xMax, dx / this.panState.bounds.width, this.dataset.xAxis.scale === "log", "x"), this.getXBounds());
    this.view.xMin = xRange.min;
    this.view.xMax = xRange.max;

    const yAxes = this.getRenderableAxes();
    for (const axis of yAxes) {
      const start = this.panState.view.y.get(axis.id);
      if (!start) continue;
      this.view.y.set(axis.id, constrainAxisView(panRange(start.min, start.max, dy / this.panState.bounds.height, axis.scale === "log", "y"), axis.unit, axis.scale));
    }
    this.applyView();
  }

  private handleWindowMouseUp(event: MouseEvent) {
    if (this.cursorDragging) {
      const point = this.localPoint(event);
      this.updateCursorFromLocalX(point.x);
      this.cancelScheduledCursorUpdate();
      this.cursorDragging = false;
      this.el.style.cursor = "ew-resize";
      this.updateCursorAtX();
      return;
    }
    if (!this.panState) return;
    const state = this.panState;
    this.panState = null;
    this.el.style.cursor = "grab";
    if (this.cursorMode !== "cursor" || state.dragging) return;
    const point = this.localPoint(event);
    if (this.isInPlot(point.x, point.y)) this.updateCursorFromLocalPoint(point.x, point.y);
  }

  private updateCursorFromLocalPoint(localX: number, localY: number) {
    if (!this.dataset || !this.isInPlot(localX, localY)) {
      this.hideCursorMarkers();
      return;
    }
    const x = this.xValueAtPixel(localX, localY);
    if (!Number.isFinite(x) || x < this.view.xMin || x > this.view.xMax) {
      this.hideCursorMarkers();
      return;
    }

    this.cursorX = this.snapXToSamples(x);
    this.updateCursorAtX();
  }

  private updateCursorFromLocalX(localX: number) {
    if (!this.dataset) return;
    const bounds = this.plotBounds();
    const clampedX = Math.min(bounds.right, Math.max(bounds.left, localX));
    const x = this.xValueAtPixel(clampedX, bounds.top + bounds.height / 2);
    if (!Number.isFinite(x)) return;
    this.cursorX = this.snapXToSamples(Math.min(this.view.xMax, Math.max(this.view.xMin, x)));
    this.scheduleCursorUpdate();
  }

  private scheduleCursorUpdate() {
    if (this.cursorUpdateFrame !== null) return;
    this.cursorUpdateFrame = requestAnimationFrame(() => {
      this.cursorUpdateFrame = null;
      this.updateCursorAtX();
    });
  }

  private cancelScheduledCursorUpdate() {
    if (this.cursorUpdateFrame === null) return;
    cancelAnimationFrame(this.cursorUpdateFrame);
    this.cursorUpdateFrame = null;
  }

  private updateCursorAtX() {
    if (!this.dataset || this.cursorX === null) return;
    this.updateDotsAtX(this.cursorX);
    this.updateCursorLine();
  }

  /** 游标圆点（scatter series）：线模式插值，点/线点模式取最近采样点。 */
  private updateDotsAtX(x: number): void {
    if (!this.dataset) return;
    const snap = this.displayMode !== "line";
    const inspectedTraces = this.getInspectionTraces();
    const updates = this.getRenderableAxes().map((axis) => {
      const data = inspectedTraces
        .filter((trace) => trace.axisId === axis.id)
        .map((trace, index) => {
          let point: [number, number] | null = null;
          if (snap) {
            point = nearestSeriesPoint(this.getRenderedPoints(trace), x);
          }
          else {
            const y = interpolateSeriesValue(this.getRenderedPoints(trace), x);
            if (y !== null) point = [x, y];
          }
          return point === null ? null : {
            value: point,
            itemStyle: { color: this.colorForTrace(trace, index) },
          };
        })
        .filter((point): point is NonNullable<typeof point> => point !== null);
      return {
        id: `cursor_axis_${axis.id}`,
        data,
      };
    });
    this.chart.setOption({ series: updates }, false);
  }

  private hideCursorMarkers() {
    if (!this.dataset) return;
    this.cancelScheduledCursorUpdate();
    this.cursorX = null;
    this.hideCursorGraphicLine();
    this.hideInspector();
    this.clearFollowDots();
  }

  /** 清空跟随模式交点圆点。 */
  private clearFollowDots(): void {
    if (!this.dataset) return;
    const updates = this.getRenderableAxes().map((axis) => ({
      id: `cursor_axis_${axis.id}`,
      data: [],
    }));
    if (updates.length) this.chart.setOption({ series: updates }, false);
  }

  private updateCursorLine() {
    this.updateCursorGraphicLine();
  }

  private updateCursorGraphicLine() {
    if (!this.dataset || this.cursorMode !== "cursor" || this.cursorX === null) {
      this.hideCursorGraphicLine();
      return;
    }
    const pixel = normalizePixel(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX), 0);
    if (!Number.isFinite(pixel)) {
      this.hideCursorGraphicLine();
      return;
    }
    const bounds = this.plotBounds();
    // 游标 x 在视野外（缩放后未收回来）时线会画到表格外面，出界即隐藏。
    if (pixel < bounds.left || pixel > bounds.right) {
      this.hideCursorGraphicLine();
      return;
    }
    this.chart.setOption({ graphic: this.cursorGraphicElements(pixel, bounds) }, false);
    this.updateInspector(pixel, bounds);
  }

  private ensureCursorPosition() {
    if (!this.dataset || this.cursorX !== null) return;
    this.cursorX = this.snapXToSamples(initialCursorValue(this.view.xMin, this.view.xMax, this.dataset.xAxis.scale === "log"));
  }

  /** 点/线点模式把 x snap 到显示曲线的最近采样点，线模式原样返回。
   *  最近采样点在视野外时保持原 x。 */
  private snapXToSamples(x: number): number {
    if (this.displayMode === "line" || !this.dataset) return x;
    // MC 叠加：吸附到 store 共享时间向量的最近采样点。
    if (this.isMonteCarloDataset()) {
      const store = this.dataset.meta.waveformStore as {
        getSeries(traceName: string): Array<{ sampleIndex: number; time: Float64Array; values: Float32Array }>;
      } | undefined;
      const traceName = this.dataset.meta.probeTraceName as string | undefined;
      const first = traceName ? store?.getSeries(traceName)[0] : undefined;
      if (!first || !first.time.length) return x;
      const time = first.time;
      let lo = 0;
      let hi = time.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (time[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      const index = lo > 0 && Math.abs(time[lo - 1] - x) < Math.abs(time[lo] - x) ? lo - 1 : lo;
      const snapped = time[index];
      if (snapped < this.view.xMin || snapped > this.view.xMax) return x;
      return snapped;
    }
    let bestX: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const trace of this.getInspectionTraces()) {
      const point = nearestSeriesPoint(this.getRenderedPoints(trace), x);
      if (!point) continue;
      const distance = Math.abs(point[0] - x);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestX = point[0];
      }
    }
    if (bestX === null || bestX < this.view.xMin || bestX > this.view.xMax) return x;
    return bestX;
  }

  private hideCursorGraphicLine() {
    this.chart.setOption({
      graphic: [
        hiddenLineGraphic("fixed-cursor-line"),
        hiddenPolygonGraphic("fixed-cursor-handle"),
      ],
    }, false);
    this.hideInspector();
  }

  private isCursorHandleHit(localX: number, localY: number): boolean {
    if (!this.dataset || this.cursorMode !== "cursor" || this.cursorX === null) return false;
    const pixel = normalizePixel(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX), 0);
    const bounds = this.plotBounds();
    return Math.abs(localX - pixel) <= 11 && localY >= bounds.top - 16 && localY <= bounds.top + 8;
  }

  private cursorGraphicElements(pixel: number, bounds: ReturnType<WaveformChart["plotBounds"]>): any[] {
    return [
      {
        id: "fixed-cursor-line",
        type: "line",
        silent: true,
        z: CURSOR_GRAPHIC_Z,
        zlevel: OVERLAY_ZLEVEL,
        invisible: false,
        shape: { x1: pixel, y1: bounds.top, x2: pixel, y2: bounds.bottom },
        style: {
          stroke: this.cursorMode === "cursor" ? "#d32029" : "rgba(0, 0, 0, 0.36)",
          lineWidth: this.cursorMode === "cursor" ? 1.5 : 1,
          lineDash: [5, 4],
        },
      },
      {
        id: "fixed-cursor-handle",
        type: "polygon",
        silent: true,
        z: CURSOR_GRAPHIC_Z + 1,
        zlevel: OVERLAY_ZLEVEL,
        invisible: this.cursorMode !== "cursor",
        shape: {
          points: [
            [pixel - 7, bounds.top - 12],
            [pixel + 7, bounds.top - 12],
            [pixel, bounds.top],
          ],
        },
        style: { fill: "#d32029", stroke: "#ffffff", lineWidth: 1 },
      },
    ];
  }

  private cursorValueItems(): Array<{ traceId: string; color: string; text: string }> {
    if (!this.dataset || this.cursorX === null) return [];
    const rows: Array<{ traceId: string; color: string; text: string }> = [];
    // 线模式：插值连续；点/线点模式：snap 最近数据点（离散语义，与 tooltip 一致）。
    const valueAt = this.displayMode === "line"
      ? (trace: WaveformTrace) => interpolateSeriesValue(this.getRenderedPoints(trace), this.cursorX as number)
      : (trace: WaveformTrace) => nearestSeriesValue(this.getRenderedPoints(trace), this.cursorX as number);
    for (const [index, trace] of this.getInspectionTraces().slice(0, CURSOR_LABEL_MAX_ROWS).entries()) {
      const y = valueAt(trace);
      if (y === null) continue;
      rows.push({
        traceId: trace.id,
        color: this.colorForTrace(trace, index),
        text: `${trace.name}: ${formatInspectionValue(y, trace.unit)}`,
      });
    }
    return rows;
  }

  private installInspectorEvents() {
    for (const eventName of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel"]) {
      this.inspectorEl.addEventListener(eventName, (event) => event.stopPropagation());
    }
    this.inspectorInputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.commitInspectorX();
        this.inspectorInputEl.select();
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (this.cursorX !== null) this.setInspectorInputValue(formatWaveformValue(this.cursorX / this.inspectorXFactor));
        this.inspectorInputEl.blur();
      }
    });
    this.inspectorInputEl.addEventListener("focus", () => {
      requestAnimationFrame(() => this.inspectorInputEl.select());
    });
    this.inspectorInputEl.addEventListener("click", () => this.inspectorInputEl.select());
    this.inspectorInputEl.addEventListener("input", () => this.updateInspectorInputWidth());
    this.inspectorInputEl.addEventListener("change", () => this.commitInspectorX());
  }

  private setInspectorInputValue(value: string) {
    this.inspectorInputEl.value = value;
    this.updateInspectorInputWidth();
  }

  private updateInspectorInputWidth() {
    const characterCount = Math.max(1, this.inspectorInputEl.value.length);
    this.inspectorInputEl.style.width = `calc(${characterCount}ch + 6px)`;
  }

  private updateInspector(pixel: number, bounds: ReturnType<WaveformChart["plotBounds"]>) {
    if (!this.dataset || this.cursorMode !== "cursor" || this.cursorX === null) {
      this.hideInspector();
      return;
    }
    const rows = this.cursorValueItems();
    const displayUnit = axisDisplayUnit(this.dataset.xAxis.unit, this.view.xMin, this.view.xMax, this.cursorX);
    const unitChanged = this.inspectorXFactor !== displayUnit.factor;
    this.inspectorXFactor = displayUnit.factor;
    this.inspectorAxisNameEl.textContent = `${this.dataset.xAxis.name}:`;
    this.inspectorUnitEl.textContent = displayUnit.label;
    const inputBounds = this.getDatasetXBounds();
    this.inspectorInputEl.min = formatWaveformValue(inputBounds.min / displayUnit.factor);
    this.inspectorInputEl.max = formatWaveformValue(inputBounds.max / displayUnit.factor);
    this.inspectorInputEl.title = t(
      "chart.inspectorInputTitle",
      this.dataset.xAxis.name,
      displayUnit.label || t("chart.inspectorUnitFallback"),
    );
    if (document.activeElement !== this.inspectorInputEl || unitChanged) {
      this.setInspectorInputValue(formatWaveformValue(this.cursorX / displayUnit.factor));
    }
    this.inspectorInputEl.removeAttribute("aria-invalid");

    const rowStructureChanged = rows.length !== this.inspectorRowElements.length
      || rows.some((row, index) => row.traceId !== this.inspectorRowElements[index]?.traceId);
    if (rowStructureChanged) {
      const fragment = document.createDocumentFragment();
      this.inspectorRowElements = rows.map((row) => {
        const rowEl = document.createElement("div");
        rowEl.className = "waveform-inspector-row";
        const swatch = document.createElement("span");
        swatch.className = "waveform-inspector-swatch";
        const value = document.createElement("span");
        value.className = "waveform-inspector-value";
        rowEl.append(swatch, value);
        fragment.appendChild(rowEl);
        return { traceId: row.traceId, row: rowEl, swatch, value };
      });
      this.inspectorRowsEl.replaceChildren(fragment);
    }
    rows.forEach((row, index) => {
      const elements = this.inspectorRowElements[index];
      elements.swatch.style.backgroundColor = row.color;
      elements.value.textContent = row.text;
    });
    this.inspectorEl.classList.remove("hidden");

    const panelWidth = this.inspectorEl.offsetWidth || 228;
    const panelHeight = this.inspectorEl.offsetHeight || 44;
    const gap = 10;
    const left = pixel + panelWidth + gap > bounds.right
      ? Math.max(bounds.left + 6, pixel - panelWidth - gap)
      : Math.min(bounds.right - panelWidth, Math.max(bounds.left + 6, pixel + gap));
    const top = Math.min(bounds.top + 8, Math.max(bounds.top + 8, bounds.bottom - panelHeight - 6));
    this.inspectorEl.style.left = `${left}px`;
    this.inspectorEl.style.top = `${top}px`;
  }

  private hideInspector() {
    this.inspectorEl.classList.add("hidden");
  }

  private commitInspectorX() {
    if (!this.dataset || this.cursorMode !== "cursor") return;
    const raw = this.inspectorInputEl.value.trim();
    const parsedDisplayValue = raw ? Number(raw) : NaN;
    const parsed = parsedDisplayValue * this.inspectorXFactor;
    const bounds = this.getDatasetXBounds();
    if (!Number.isFinite(parsed) || (bounds.isLog && parsed <= 0)) {
      this.inspectorInputEl.setAttribute("aria-invalid", "true");
      return;
    }
    const target = clamp(parsed, bounds.min, bounds.max);
    this.inspectorInputEl.removeAttribute("aria-invalid");
    this.cursorX = this.snapXToSamples(target);
    this.setInspectorInputValue(formatWaveformValue(this.cursorX / this.inspectorXFactor));
    this.centerViewAtX(target, bounds);
    this.applyView();
    requestAnimationFrame(() => this.updateCursorAtX());
  }

  private centerViewAtX(target: number, bounds: XBounds) {
    if (target >= this.view.xMin && target <= this.view.xMax) return;
    if (bounds.isLog) {
      const span = Math.log10(this.view.xMax) - Math.log10(this.view.xMin);
      const center = Math.log10(target);
      const next = constrainXView({
        min: 10 ** (center - span / 2),
        max: 10 ** (center + span / 2),
      }, bounds);
      this.view.xMin = next.min;
      this.view.xMax = next.max;
      return;
    }
    const span = this.view.xMax - this.view.xMin;
    const next = constrainXView({ min: target - span / 2, max: target + span / 2 }, bounds);
    this.view.xMin = next.min;
    this.view.xMax = next.max;
  }

  private applyView() {
    if (!this.dataset) return;
    const yAxes = this.getRenderableAxes();
    const yAxisRanges = this.getRenderableYAxisRanges(yAxes);
    const seriesUpdates = this.getVisibleTraces()
      .map((trace) => this.buildTraceSeriesViewUpdate(trace));
    this.chart.setOption({
      xAxis: {
        min: this.view.xMin,
        max: this.view.xMax,
        minInterval: axisMinInterval(this.dataset.xAxis.unit, this.dataset.xAxis.scale, this.view.xMin, this.view.xMax),
        axisLabel: {
          formatter: makeAxisLabelFormatter(this.dataset.xAxis.unit, this.dataset.xAxis.scale, this.view.xMin, this.view.xMax),
        },
      },
      yAxis: yAxes.map((axis, index) => this.buildYAxisViewUpdate(axis, index, yAxisRanges)),
      series: seriesUpdates,
    });
    if (this.cursorMode === "cursor" && this.cursorX !== null) {
      this.cursorX = this.snapXToSamples(clamp(this.cursorX, this.view.xMin, this.view.xMax));
      this.updateCursorAtX();
    }
    // 视野变了但鼠标未必动，重画覆盖层。
    // 缩放/平移不走 render()，必须在这里通知叠加画布同步几何并重绘。
    this.renderCallbacks.onViewChange.forEach((callback) => callback());
    this.scheduleFollowOverlay();
  }

  private getVisibleTraces(): WaveformTrace[] {
    if (!this.dataset) return [];
    if (!this.visibleTraceIds) return this.dataset.traces;
    return this.dataset.traces.filter((trace) => this.visibleTraceIds?.has(trace.id));
  }

  private getDisplayedTraces(): WaveformTrace[] {
    const traces = this.getVisibleTraces().filter((trace) => !this.legendHiddenTraceIds.has(trace.id));
    return traces.length ? traces : [];
  }

  private getInspectionTraces(): WaveformTrace[] {
    // "__" 开头的是隐形 scaffold 线（只用于撑轴范围），不得进入任何数值读出。
    const traces = this.getDisplayedTraces().filter((trace) => !trace.name.startsWith("__"));
    if (!this.highlightedTraceIds?.size) return traces;
    return traces.filter((trace) => this.highlightedTraceIds?.has(trace.id));
  }

  private handleLegendSelectionChanged(event: { selected?: Record<string, boolean> }) {
    if (!this.dataset || !event?.selected) return;
    const nextHidden = new Set<string>();
    for (const trace of this.getVisibleTraces()) {
      if (event.selected[trace.name] === false) nextHidden.add(trace.id);
    }
    this.legendHiddenTraceIds = nextHidden;
    if (this.cursorMode === "cursor") {
      this.ensureCursorPosition();
      this.updateCursorAtX();
      requestAnimationFrame(() => this.restoreCursorAfterRender());
      return;
    }
    this.hideCursorMarkers();
    // legend 变化后圆点要重算。
    this.scheduleFollowOverlay();
  }

  private colorForTrace(trace: WaveformTrace, fallbackIndex: number): string {
    if (trace.color) return trace.color;
    const stableIndex = this.dataset?.traces.findIndex((item) => item.id === trace.id) ?? -1;
    const index = stableIndex >= 0 ? stableIndex : fallbackIndex;
    return traceColorAt(index);
  }

  private getRenderableAxes(): WaveformAxis[] {
    if (!this.dataset) return [];
    const visibleAxisIds = new Set(this.getVisibleTraces().map((trace) => trace.axisId));
    const axes = this.dataset.yAxes.filter((axis) => visibleAxisIds.has(axis.id));
    return axes.length ? axes : this.dataset.yAxes;
  }

  private getRenderableYAxisRanges(yAxes: WaveformAxis[]): Map<string, { min: number; max: number }> {
    return new Map(yAxes.map((axis) => {
      const range = this.view.y.get(axis.id);
      return [axis.id, readableAxisRange(range, axis.unit, axis.scale)];
    }));
  }

  private getXBounds(): XBounds {
    if (!this.dataset) return { min: this.view.xMin, max: this.view.xMax, isLog: false };
    const boundsTraces = this.getDisplayedTraces();
    const xs = (boundsTraces.length ? boundsTraces : this.getVisibleTraces())
      .flatMap((trace) => trace.points.map((point) => point[0]))
      .filter((value) => Number.isFinite(value) && (this.dataset?.xAxis.scale !== "log" || value > 0));
    if (!xs.length) return { min: this.view.xMin, max: this.view.xMax, isLog: this.dataset.xAxis.scale === "log" };
    const [min, max] = extent(xs);
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: this.view.xMin, max: this.view.xMax, isLog: this.dataset.xAxis.scale === "log" };
    }
    return { min, max, isLog: this.dataset.xAxis.scale === "log" };
  }

  private getDatasetXBounds(): XBounds {
    if (this.datasetXBounds) return this.datasetXBounds;
    if (!this.dataset) return { min: this.view.xMin, max: this.view.xMax, isLog: false };
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    for (const trace of this.dataset.traces) {
      for (const point of trace.points) {
        const value = point[0];
        if (!Number.isFinite(value) || (this.dataset.xAxis.scale === "log" && value <= 0)) continue;
        minimum = Math.min(minimum, value);
        maximum = Math.max(maximum, value);
      }
    }
    this.datasetXBounds = Number.isFinite(minimum) && Number.isFinite(maximum)
      ? { min: minimum, max: maximum, isLog: this.dataset.xAxis.scale === "log" }
      : { min: this.view.xMin, max: this.view.xMax, isLog: this.dataset.xAxis.scale === "log" };
    return this.datasetXBounds;
  }

  private localPoint(event: MouseEvent) {
    const rect = this.el.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private isInPlot(localX: number, localY: number): boolean {
    return this.chart.containPixel({ gridIndex: 0 }, [localX, localY]);
  }

  private xValueAtPixel(localX: number, _localY: number): number {
    if (!this.dataset) return NaN;
    const bounds = this.plotBounds();
    const ratio = clamp((localX - bounds.left) / bounds.width, 0, 1);
    if (this.dataset.xAxis.scale === "log") {
      const logMin = Math.log10(Math.max(this.view.xMin, Number.MIN_VALUE));
      const logMax = Math.log10(Math.max(this.view.xMax, Number.MIN_VALUE));
      return 10 ** (logMin + (logMax - logMin) * ratio);
    }
    return this.view.xMin + (this.view.xMax - this.view.xMin) * ratio;
  }

  private yValueAtPixel(axisIndex: number, _localX: number, localY: number): number {
    const axis = this.getRenderableAxes()[axisIndex];
    if (!axis) return NaN;
    const bounds = this.plotBounds();
    const range = readableAxisRange(this.view.y.get(axis.id), axis.unit, axis.scale);
    const ratio = clamp((localY - bounds.top) / bounds.height, 0, 1);
    if (axis.scale === "log") {
      const logMin = Math.log10(Math.max(range.min, Number.MIN_VALUE));
      const logMax = Math.log10(Math.max(range.max, Number.MIN_VALUE));
      return 10 ** (logMax - (logMax - logMin) * ratio);
    }
    return range.max - (range.max - range.min) * ratio;
  }

  private plotBounds() {
    if (!this.dataset) {
      return {
        left: 0,
        right: this.el.clientWidth,
        top: 0,
        bottom: this.el.clientHeight,
        width: Math.max(1, this.el.clientWidth),
        height: Math.max(1, this.el.clientHeight),
      };
    }
    const yAxes = this.getRenderableAxes();
    const yAxis = yAxes[0];
    const yRange = yAxis ? this.view.y.get(yAxis.id) : null;
    const left = normalizePixel(this.chart.convertToPixel({ xAxisIndex: 0 }, this.view.xMin), 0);
    const right = normalizePixel(this.chart.convertToPixel({ xAxisIndex: 0 }, this.view.xMax), 0);
    const top = yAxis && yRange ? normalizePixel(this.chart.convertToPixel({ yAxisIndex: 0 }, yRange.max), 1) : 48;
    const bottom = yAxis && yRange ? normalizePixel(this.chart.convertToPixel({ yAxisIndex: 0 }, yRange.min), 1) : this.el.clientHeight - 54;
    if ([left, right, top, bottom].every(Number.isFinite)) {
      return {
        left: Math.min(left, right),
        right: Math.max(left, right),
        top: Math.min(top, bottom),
        bottom: Math.max(top, bottom),
        width: Math.max(1, Math.abs(right - left)),
        height: Math.max(1, Math.abs(bottom - top)),
      };
    }
    return {
      left: 76,
      right: Math.max(77, this.el.clientWidth - 32),
      top: 46,
      bottom: Math.max(47, this.el.clientHeight - 54),
      width: Math.max(1, this.el.clientWidth - 108),
      height: Math.max(1, this.el.clientHeight - 100),
    };
  }
}


function hiddenLineGraphic(id: string): any {
  return {
    id,
    type: "line",
    invisible: true,
    silent: true,
    shape: { x1: 0, y1: 0, x2: 0, y2: 0 },
  };
}

function hiddenPolygonGraphic(id: string): any {
  return {
    id,
    type: "polygon",
    invisible: true,
    silent: true,
    shape: { points: [[0, 0], [0, 0], [0, 0]] },
  };
}

function normalizePixel(pixel: number | number[], index: number): number {
  return Array.isArray(pixel) ? Number(pixel[index]) : Number(pixel);
}

function createWatermarkPattern() {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  canvas.width = 300;
  canvas.height = 170;
  if (!ctx) return "#f7f8fa";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.032;
  ctx.font = "22px Microsoft YaHei";
  ctx.translate(58, 44);
  ctx.rotate(-Math.PI / 6);
  ctx.fillText("JLC NGSPICE", 0, 78);
  return { type: "pattern" as const, image: canvas, repeat: "repeat" as const };
}
