import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import type { WaveformAxis, WaveformDataset, WaveformTrace } from "./types";

type DisplayMode = "line" | "points" | "both";
type CursorMode = "follow" | "cursor";
type AxisScale = "linear" | "log";

interface ViewState {
  xMin: number;
  xMax: number;
  y: Map<string, { min: number; max: number }>;
}

interface XBounds {
  min: number;
  max: number;
  isLog: boolean;
}

interface RenderedTraceData {
  points: Array<[number, number]>;
  sourceCount: number;
}

interface PanState {
  x: number;
  y: number;
  startedAt: number;
  bounds: { width: number; height: number };
  view: ViewState;
  dragging: boolean;
}

const displayLabels: Record<DisplayMode, string> = {
  line: "仅线",
  points: "仅点",
  both: "线+点",
};

const cursorLabels: Record<CursorMode, string> = {
  follow: "跟随",
  cursor: "游标",
};

const TARGET_POINTS_PER_PIXEL = 2.5;
const MIN_RENDER_POINTS = 1200;
const MAX_RENDER_POINTS = 12000;
const CURSOR_GRAPHIC_Z = 10000;
const CURSOR_LABEL_MAX_ROWS = 8;
export const TRACE_PALETTE = ["#1890ff", "#fa8c16", "#13a8a8", "#52c41a", "#6128ff", "#d73843", "#8c8c8c", "#096dd9"];
const TRACE_LEGEND_ICON = "path://M0 5 L20 5 L20 7 L0 7 Z M10 2 A4 4 0 1 0 10 10 A4 4 0 1 0 10 2 Z";

export function traceColorAt(index: number): string {
  return TRACE_PALETTE[Math.max(0, index) % TRACE_PALETTE.length];
}

export class WaveformChart {
  private chart: ECharts;
  private dataset: WaveformDataset | null = null;
  private displayMode: DisplayMode = "line";
  private cursorMode: CursorMode = "follow";
  private cursorX: number | null = null;
  private cursorDragging = false;
  private visibleTraceIds: Set<string> | null = null;
  private legendHiddenTraceIds = new Set<string>();
  private panState: PanState | null = null;
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
    this.el.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    this.el.addEventListener("mousemove", (event) => this.handleMouseMove(event));
    this.el.addEventListener("mouseleave", () => this.handleMouseLeave());
    this.el.addEventListener("mousedown", (event) => this.handleMouseDown(event));
    window.addEventListener("mousemove", (event) => this.handleWindowMouseMove(event));
    window.addEventListener("mouseup", (event) => this.handleWindowMouseUp(event));
    window.addEventListener("resize", () => this.resize());
    this.chart.on("legendselectchanged", (event: any) => this.handleLegendSelectionChanged(event));
    this.renderEmpty();
  }

  setDataset(dataset: WaveformDataset | null) {
    const previousDatasetId = this.dataset?.id ?? null;
    this.dataset = dataset;
    this.panState = null;
    if (!dataset || dataset.id !== previousDatasetId) this.cursorX = null;
    if (!dataset) {
      this.renderEmpty();
      return;
    }
    this.legendHiddenTraceIds = new Set([...this.legendHiddenTraceIds].filter((id) => dataset.traces.some((trace) => trace.id === id)));
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
  }

  cycleDisplayMode(): string {
    const modes: DisplayMode[] = ["line", "points", "both"];
    const index = modes.indexOf(this.displayMode);
    this.displayMode = modes[(index + 1) % modes.length];
    this.render();
    return displayLabels[this.displayMode];
  }

  getDisplayLabel(): string {
    return displayLabels[this.displayMode];
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
    return cursorLabels[this.cursorMode];
  }

  getCursorModeLabel(): string {
    return cursorLabels[this.cursorMode];
  }

  private renderEmpty() {
    this.titleEl.textContent = "NGspice 波形结果";
    this.badgesEl.innerHTML = `<span class="eda-tag">等待运行</span>`;
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
          text: "导入或粘贴 NGspice 网表后点击运行",
          fill: "#868686",
          font: "12px Microsoft YaHei",
        },
      },
    } satisfies EChartsOption, true);
  }

  private render() {
    if (!this.dataset) return;
    if (this.cursorMode === "cursor") this.ensureCursorPosition();
    const dataset = this.dataset;
    const visibleTraces = this.getVisibleTraces();
    const yAxes = this.getRenderableAxes();
    const yAxisRanges = this.getRenderableYAxisRanges(yAxes);
    const visibleColors = visibleTraces.map((trace, index) => this.colorForTrace(trace, index));

    this.titleEl.textContent = dataset.title;
    this.badgesEl.innerHTML = [
      `<span class="eda-tag">${labelForAnalysis(dataset.analysisType)}</span>`,
      dataset.command ? `<span class="eda-tag neutral">${escapeHtml(dataset.command)}</span>` : "",
      `<span class="eda-tag neutral">${visibleTraces.length}/${dataset.traces.length} 曲线</span>`,
      `<span class="eda-tag neutral">${formatInteger(visibleTraces.reduce((sum, trace) => sum + trace.points.length, 0))} 采样点</span>`,
    ].filter(Boolean).join("");
    this.el.title = this.cursorMode === "follow"
      ? "滚轮按鼠标位置缩放；按住左键拖动平移；数值线跟随鼠标"
      : "滚轮按鼠标位置缩放；游标线可点击或拖动定位";

    const showEmptyHint = visibleTraces.length === 0;
    const option: EChartsOption = {
      color: visibleColors,
      backgroundColor: createWatermarkPattern() as any,
      animation: true,
      animationDuration: 450,
      tooltip: {
        show: true,
        trigger: this.cursorMode === "follow" ? "axis" : "item",
        confine: true,
        backgroundColor: "#fff",
        borderColor: "#d9d9d9",
        borderWidth: 1,
        textStyle: { color: "#333", fontSize: 12 },
        axisPointer: {
          type: this.cursorMode === "follow" ? "line" : "none",
          snap: this.displayMode !== "line",
          lineStyle: { color: "rgba(0,0,0,0.24)", type: "dashed", width: 1 },
        },
        formatter: (params) => this.formatTooltip(Array.isArray(params) ? params : [params]),
      },
      legend: {
        top: 0,
        type: "scroll",
        itemWidth: 20,
        itemHeight: 12,
        data: visibleTraces.map((trace) => ({ name: trace.name, icon: TRACE_LEGEND_ICON })),
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
      yAxis: yAxes.map((axis, index) => ({
        type: axis.scale === "log" ? "log" : "value",
        scale: true,
        position: index === 0 ? "left" : "right",
        offset: 0,
        min: yAxisRanges.get(axis.id)?.min,
        max: yAxisRanges.get(axis.id)?.max,
        minInterval: axisMinInterval(axis.unit, axis.scale, yAxisRanges.get(axis.id)?.min, yAxisRanges.get(axis.id)?.max),
        splitNumber: 4,
        name: `${axis.name}${axis.unit ? ` (${axis.unit})` : ""}`,
        nameLocation: "end",
        nameGap: 12,
        nameTextStyle: {
          color: "#868686",
          fontSize: 12,
          align: index === 0 ? "right" : "left",
        },
        axisLabel: {
          color: "#5f6874",
          hideOverlap: false,
          margin: 8,
          width: 62,
          overflow: "truncate",
          align: index === 0 ? "right" : "left",
          formatter: makeAxisLabelFormatter(axis.unit, axis.scale, yAxisRanges.get(axis.id)?.min, yAxisRanges.get(axis.id)?.max),
        },
        axisLine: { show: true, onZero: false, lineStyle: { color: "#87909e" } },
        splitLine: { show: index === 0, lineStyle: { color: "#dde2e8" } },
        minorTick: { show: axis.scale !== "log" },
        minorSplitLine: { show: index === 0 && axis.scale !== "log", lineStyle: { color: "#edf0f4" } },
      })),
      series: [
        ...visibleTraces.map((trace, index) => this.buildTraceSeries(trace, index, yAxes)),
        ...visibleTraces.map((trace, index) => this.buildCursorSeries(trace, index, yAxes)),
      ],
      graphic: showEmptyHint
        ? {
            type: "text",
            left: "center",
            top: "middle",
            style: {
              text: "未选择波形",
              fill: "#868686",
              font: "12px Microsoft YaHei",
            },
          }
        : undefined,
    };

    this.chart.setOption(option, true);
    this.restoreCursorAfterRender();
  }

  private restoreCursorAfterRender() {
    if (this.cursorMode !== "cursor" || !this.dataset) return;
    this.ensureCursorPosition();
    if (this.cursorX !== null) this.cursorX = clamp(this.cursorX, this.view.xMin, this.view.xMax);
    this.updateCursorAtX();
  }

  private buildTraceSeries(trace: WaveformTrace, index: number, yAxes: WaveformAxis[]) {
    const axisIndex = Math.max(0, yAxes.findIndex((axis) => axis.id === trace.axisId));
    const showLine = this.displayMode !== "points";
    const rendered = this.renderTraceData(trace);
    const showPoints = this.displayMode !== "line" && rendered.points.length <= 6000;
    const color = this.colorForTrace(trace, index);
    return {
      id: trace.id,
      name: trace.name,
      type: "line" as const,
      yAxisIndex: axisIndex,
      data: rendered.points,
      symbol: "circle",
      showSymbol: showPoints,
      symbolSize: showPoints ? 3.5 : 0,
      smooth: false,
      sampling: undefined,
      large: rendered.points.length > 8000,
      progressive: rendered.points.length > 8000 ? 5000 : 0,
      lineStyle: {
        color,
        width: showLine ? 1.6 : 0,
        opacity: showLine ? 1 : 0,
      },
      itemStyle: { color },
      emphasis: { focus: "series" as const },
    };
  }

  private buildTraceSeriesViewUpdate(trace: WaveformTrace) {
    const rendered = this.renderTraceData(trace);
    const showPoints = this.displayMode !== "line" && rendered.points.length <= 6000;
    return {
      id: trace.id,
      data: rendered.points,
      showSymbol: showPoints,
      symbolSize: showPoints ? 3.5 : 0,
      large: rendered.points.length > 8000,
      progressive: rendered.points.length > 8000 ? 5000 : 0,
    };
  }

  private renderTraceData(trace: WaveformTrace): RenderedTraceData {
    const points = windowedPoints(trace.points, this.view.xMin, this.view.xMax);
    const maxPoints = this.maxRenderPoints();
    if (points.length <= maxPoints) return { points, sourceCount: points.length };
    return {
      points: downsamplePreserveExtremes(points, maxPoints),
      sourceCount: points.length,
    };
  }

  private maxRenderPoints(): number {
    const width = this.plotBounds().width || this.el.clientWidth || 480;
    return clamp(Math.floor(width * TARGET_POINTS_PER_PIXEL), MIN_RENDER_POINTS, MAX_RENDER_POINTS);
  }

  private buildCursorSeries(trace: WaveformTrace, index: number, yAxes: WaveformAxis[]) {
    const axisIndex = Math.max(0, yAxes.findIndex((axis) => axis.id === trace.axisId));
    const color = this.colorForTrace(trace, index);
    return {
      id: `cursor_${trace.id}`,
      name: `__cursor_${trace.name}`,
      type: "scatter" as const,
      yAxisIndex: axisIndex,
      data: [],
      symbol: "circle",
      symbolSize: 8,
      z: 20,
      silent: true,
      animation: false,
      itemStyle: {
        color,
        borderColor: "#ffffff",
        borderWidth: 1.5,
      },
      tooltip: { show: false },
    };
  }

  private formatTooltip(params: Array<Record<string, any>>): string {
    if (!this.dataset || !params.length) return "";
    const x = Number(params[0].axisValue);
    let html = `<div class="chart-tip"><b>${escapeHtml(this.dataset.xAxis.name)}: ${formatAxisValue(x, this.dataset.xAxis.unit)}</b><br/>`;
    for (const param of params) {
      if (String(param.seriesName).startsWith("__cursor_")) continue;
      const trace = this.dataset.traces.find((item) => item.name === param.seriesName);
      const value = Array.isArray(param.value) ? Number(param.value[1]) : Number(param.value);
      html += `${param.marker || ""}${escapeHtml(param.seriesName)}: ${formatAxisValue(value, trace?.unit || "")}<br/>`;
    }
    return `${html}</div>`;
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
    if (this.cursorMode === "follow") this.updateCursorFromLocalPoint(localX, localY);
  }

  private handleMouseMove(event: MouseEvent) {
    if (!this.dataset || this.panState || this.cursorDragging) return;
    const point = this.localPoint(event);
    if (this.cursorMode === "cursor" && this.isCursorHandleHit(point.x, point.y)) {
      this.el.style.cursor = "ew-resize";
      return;
    }
    if (!this.isInPlot(point.x, point.y)) {
      if (this.cursorMode === "follow") this.hideCursorMarkers();
      this.el.style.cursor = "default";
      return;
    }
    this.el.style.cursor = this.cursorMode === "cursor"
      ? this.isCursorHandleHit(point.x, point.y) ? "ew-resize" : "default"
      : "grab";
    if (this.cursorMode === "follow") this.updateCursorFromLocalPoint(point.x, point.y);
  }

  private handleMouseLeave() {
    if (this.cursorMode === "follow") this.hideCursorMarkers();
  }

  private handleMouseDown(event: MouseEvent) {
    if (!this.dataset || event.button !== 0) return;
    const point = this.localPoint(event);
    if (this.cursorMode === "cursor") {
      if (!this.isCursorHandleHit(point.x, point.y)) return;
      this.cursorDragging = true;
      this.el.style.cursor = "ew-resize";
      event.preventDefault();
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
    const dx = point.x - this.panState.x;
    const dy = point.y - this.panState.y;
    const distance = Math.hypot(dx, dy);
    if (!this.panState.dragging && performance.now() - this.panState.startedAt < 120 && distance < 3) return;

    this.panState.dragging = true;
    this.el.style.cursor = "grabbing";
    this.hideCursorMarkers();
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
      this.cursorDragging = false;
      this.el.style.cursor = "ew-resize";
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

    this.cursorX = x;
    this.updateCursorAtX();
  }

  private updateCursorFromLocalX(localX: number) {
    if (!this.dataset) return;
    const bounds = this.plotBounds();
    const clampedX = Math.min(bounds.right, Math.max(bounds.left, localX));
    const x = this.xValueAtPixel(clampedX, bounds.top + bounds.height / 2);
    if (!Number.isFinite(x)) return;
    this.cursorX = Math.min(this.view.xMax, Math.max(this.view.xMin, x));
    this.updateCursorAtX();
  }

  private updateCursorAtX() {
    if (!this.dataset || this.cursorX === null) return;
    const x = this.cursorX;
    const updates = this.getVisibleTraces().map((trace) => {
      const y = this.legendHiddenTraceIds.has(trace.id) ? null : interpolateSeriesValue(trace.points, x);
      return {
        id: `cursor_${trace.id}`,
        data: y === null ? [] : [[x, y]],
      };
    });
    this.chart.setOption({ series: updates }, false);
    this.updateCursorLine();
  }

  private hideCursorMarkers() {
    if (!this.dataset) return;
    this.cursorX = null;
    this.hideCursorGraphicLine();
    const updates = this.getVisibleTraces().map((trace) => ({
      id: `cursor_${trace.id}`,
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
    this.chart.setOption({ graphic: this.cursorGraphicElements(pixel, bounds) }, false);
  }

  private ensureCursorPosition() {
    if (!this.dataset || this.cursorX !== null) return;
    this.cursorX = initialCursorValue(this.view.xMin, this.view.xMax, this.dataset.xAxis.scale === "log");
  }

  private hideCursorGraphicLine() {
    this.chart.setOption({
      graphic: [
        hiddenLineGraphic("fixed-cursor-line"),
        hiddenPolygonGraphic("fixed-cursor-handle"),
        ...hiddenCursorLabelGraphics(),
      ],
    }, false);
  }

  private isCursorHandleHit(localX: number, localY: number): boolean {
    if (!this.dataset || this.cursorMode !== "cursor" || this.cursorX === null) return false;
    const pixel = normalizePixel(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX), 0);
    const bounds = this.plotBounds();
    return Math.abs(localX - pixel) <= 11 && localY >= bounds.top - 16 && localY <= bounds.top + 8;
  }

  private cursorGraphicElements(pixel: number, bounds: ReturnType<WaveformChart["plotBounds"]>): any[] {
    const valueItems = this.cursorValueItems();
    const labelWidth = 228;
    const labelPadding = 8;
    const headerHeight = 20;
    const rowHeight = 18;
    const labelHeight = Math.max(30, labelPadding * 2 + headerHeight + valueItems.rows.length * rowHeight);
    const labelGap = 10;
    const labelX = pixel + labelWidth + labelGap > bounds.right
      ? Math.max(bounds.left + 6, pixel - labelWidth - labelGap)
      : Math.min(bounds.right - labelWidth, Math.max(bounds.left + 6, pixel + labelGap));
    const labelY = Math.min(Math.max(bounds.top + 8, bounds.top + 8), Math.max(bounds.top + 8, bounds.bottom - labelHeight - 6));
    const labelGraphics: any[] = [
      {
        id: "fixed-cursor-label-bg",
        type: "rect",
        silent: true,
        z: CURSOR_GRAPHIC_Z + 2,
        invisible: false,
        shape: { x: labelX, y: labelY, width: labelWidth, height: labelHeight, r: 3 },
        style: {
          fill: "#ffffff",
          stroke: "#d9d9d9",
          lineWidth: 1,
          shadowBlur: 10,
          shadowColor: "rgba(0, 0, 0, 0.14)",
          shadowOffsetY: 2,
        },
      },
      {
        id: "fixed-cursor-label-header",
        type: "text",
        silent: true,
        z: CURSOR_GRAPHIC_Z + 3,
        invisible: false,
        x: labelX + labelPadding,
        y: labelY + labelPadding,
        style: {
          text: valueItems.header,
          fill: "#333333",
          font: "bold 12px Microsoft YaHei",
          width: labelWidth - labelPadding * 2,
          overflow: "truncate",
        },
      },
    ];
    for (let index = 0; index < CURSOR_LABEL_MAX_ROWS; index += 1) {
      const row = valueItems.rows[index];
      const rowY = labelY + labelPadding + headerHeight + index * rowHeight;
      const isVisible = Boolean(row);
      labelGraphics.push(
        {
          id: `fixed-cursor-label-dot-${index}`,
          type: "circle",
          silent: true,
          z: CURSOR_GRAPHIC_Z + 3,
          invisible: !isVisible,
          shape: { cx: labelX + labelPadding + 4, cy: rowY + 7, r: 4 },
          style: { fill: row?.color || "#333333" },
        },
        {
          id: `fixed-cursor-label-row-${index}`,
          type: "text",
          silent: true,
          z: CURSOR_GRAPHIC_Z + 3,
          invisible: !isVisible,
          x: labelX + labelPadding + 14,
          y: rowY,
          style: {
            text: row?.text || "",
            fill: "#333333",
            font: "12px Microsoft YaHei",
            width: labelWidth - labelPadding * 2 - 14,
            overflow: "truncate",
          },
        },
      );
    }
    return [
      {
        id: "fixed-cursor-line",
        type: "line",
        silent: true,
        z: CURSOR_GRAPHIC_Z,
        invisible: false,
        shape: { x1: pixel, y1: bounds.top, x2: pixel, y2: bounds.bottom },
        style: { stroke: "#d32029", lineWidth: 1.5, lineDash: [5, 4] },
      },
      {
        id: "fixed-cursor-handle",
        type: "polygon",
        silent: true,
        z: CURSOR_GRAPHIC_Z + 1,
        invisible: false,
        shape: {
          points: [
            [pixel - 7, bounds.top - 12],
            [pixel + 7, bounds.top - 12],
            [pixel, bounds.top],
          ],
        },
        style: { fill: "#d32029", stroke: "#ffffff", lineWidth: 1 },
      },
      ...labelGraphics,
    ];
  }

  private cursorValueItems(): { header: string; rows: Array<{ color: string; text: string }> } {
    if (!this.dataset || this.cursorX === null) return { header: "", rows: [] };
    const header = `${this.dataset.xAxis.name}: ${formatAxisValue(this.cursorX, this.dataset.xAxis.unit)}`;
    const rows: Array<{ color: string; text: string }> = [];
    for (const [index, trace] of this.getDisplayedTraces().slice(0, CURSOR_LABEL_MAX_ROWS).entries()) {
      const y = interpolateSeriesValue(trace.points, this.cursorX);
      if (y === null) continue;
      rows.push({
        color: this.colorForTrace(trace, index),
        text: `${trace.name}: ${formatAxisValue(y, trace.unit)}`,
      });
    }
    return { header, rows };
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
      yAxis: yAxes.map((axis) => ({
        min: yAxisRanges.get(axis.id)?.min,
        max: yAxisRanges.get(axis.id)?.max,
        minInterval: axisMinInterval(axis.unit, axis.scale, yAxisRanges.get(axis.id)?.min, yAxisRanges.get(axis.id)?.max),
        axisLabel: {
          formatter: makeAxisLabelFormatter(axis.unit, axis.scale, yAxisRanges.get(axis.id)?.min, yAxisRanges.get(axis.id)?.max),
        },
      })),
      series: seriesUpdates,
    });
    if (this.cursorX !== null) this.updateCursorLine();
    if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateCursorAtX();
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

  private getCursorLineTraceId(): string | null {
    return this.getDisplayedTraces()[0]?.id ?? this.getVisibleTraces()[0]?.id ?? null;
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
    return {
      min: Math.min(...xs),
      max: Math.max(...xs),
      isLog: this.dataset.xAxis.scale === "log",
    };
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

  private xValueAtPixel(localX: number, localY: number): number {
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

  private yValueAtPixel(axisIndex: number, localX: number, localY: number): number {
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

function computeView(dataset: WaveformDataset, traces: WaveformTrace[] = dataset.traces): ViewState {
  const allPoints = traces.flatMap((trace) => trace.points);
  const xs = allPoints.map((point) => point[0]).filter((value) => Number.isFinite(value) && (dataset.xAxis.scale !== "log" || value > 0));
  const xRange = paddedRange(xs, dataset.xAxis.scale === "log");
  const y = new Map<string, { min: number; max: number }>();
  const axes = dataset.yAxes.length ? dataset.yAxes : [{ id: "voltage", name: "Voltage", unit: "V", scale: "linear" as const }];
  for (const axis of axes) {
    const values = traces
      .filter((trace) => trace.axisId === axis.id)
      .flatMap((trace) => trace.points.map((point) => point[1]))
      .filter(Number.isFinite);
    y.set(axis.id, paddedRange(values, axis.scale === "log"));
  }
  return { xMin: xRange.min, xMax: xRange.max, y };
}

function fitXToDataBounds(dataset: WaveformDataset, traces: WaveformTrace[]): Pick<ViewState, "xMin" | "xMax"> {
  const xs = traces
    .flatMap((trace) => trace.points.map((point) => point[0]))
    .filter((value) => Number.isFinite(value) && (dataset.xAxis.scale !== "log" || value > 0));
  if (!xs.length) return { xMin: 0, xMax: 1 };

  const min = Math.min(...xs);
  const max = Math.max(...xs);
  if (min === max) {
    if (dataset.xAxis.scale === "log") {
      return { xMin: Math.max(Number.MIN_VALUE, min / 10), xMax: max * 10 };
    }
    const pad = Math.abs(min || 1) * 0.1;
    return { xMin: min - pad, xMax: max + pad };
  }
  return { xMin: min, xMax: max };
}

function initialCursorValue(min: number, max: number, isLog: boolean): number {
  if (isLog) return Math.max(min, Number.MIN_VALUE);
  return Math.min(max, Math.max(min, 0));
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

function hiddenCursorLabelGraphics(): any[] {
  const graphics: any[] = [
    hiddenRectGraphic("fixed-cursor-label-bg"),
    hiddenTextGraphic("fixed-cursor-label-header"),
  ];
  for (let index = 0; index < CURSOR_LABEL_MAX_ROWS; index += 1) {
    graphics.push(
      hiddenCircleGraphic(`fixed-cursor-label-dot-${index}`),
      hiddenTextGraphic(`fixed-cursor-label-row-${index}`),
    );
  }
  return graphics;
}

function hiddenRectGraphic(id: string): any {
  return {
    id,
    type: "rect",
    invisible: true,
    silent: true,
    shape: { x: 0, y: 0, width: 0, height: 0 },
  };
}

function hiddenCircleGraphic(id: string): any {
  return {
    id,
    type: "circle",
    invisible: true,
    silent: true,
    shape: { cx: 0, cy: 0, r: 0 },
  };
}

function hiddenTextGraphic(id: string): any {
  return {
    id,
    type: "text",
    invisible: true,
    silent: true,
    style: { text: "" },
  };
}

function paddedRange(values: number[], isLog: boolean): { min: number; max: number } {
  const usable = values.filter((value) => Number.isFinite(value) && (!isLog || value > 0));
  if (!usable.length) return isLog ? { min: 1, max: 10 } : { min: 0, max: 1 };
  const min = Math.min(...usable);
  const max = Math.max(...usable);
  if (min === max) {
    const pad = Math.abs(min || 1) * 0.1;
    return isLog ? { min: Math.max(Number.MIN_VALUE, min / 10), max: max * 10 } : { min: min - pad, max: max + pad };
  }
  if (isLog) {
    const logMin = Math.log10(min);
    const logMax = Math.log10(max);
    const pad = Math.max((logMax - logMin) * 0.04, 0.04);
    return { min: 10 ** (logMin - pad), max: 10 ** (logMax + pad) };
  }
  const pad = Math.max((max - min) * 0.08, Number.EPSILON);
  return { min: min - pad, max: max + pad };
}

function zoomRange(min: number, max: number, focus: number, scale: number, isLog: boolean) {
  if (!Number.isFinite(focus)) focus = (min + max) / 2;
  if (isLog) {
    const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
    const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
    const logFocus = Math.log10(Math.max(focus, Number.MIN_VALUE));
    return {
      min: 10 ** (logFocus - (logFocus - logMin) * scale),
      max: 10 ** (logFocus + (logMax - logFocus) * scale),
    };
  }
  return {
    min: focus - (focus - min) * scale,
    max: focus + (max - focus) * scale,
  };
}

function panRange(min: number, max: number, ratio: number, isLog: boolean, direction: "x" | "y") {
  const signedRatio = direction === "x" ? -ratio : ratio;
  if (isLog) {
    const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
    const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
    const shift = signedRatio * (logMax - logMin);
    return {
      min: 10 ** (logMin + shift),
      max: 10 ** (logMax + shift),
    };
  }
  const shift = signedRatio * (max - min);
  return {
    min: min + shift,
    max: max + shift,
  };
}

function constrainXView(range: { min: number; max: number }, bounds: XBounds): { min: number; max: number } {
  const dataMin = Math.min(bounds.min, bounds.max);
  const dataMax = Math.max(bounds.min, bounds.max);
  if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMin === dataMax) return range;

  let min = Math.min(range.min, range.max);
  let max = Math.max(range.min, range.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: dataMin, max: dataMax };

  if (bounds.isLog) {
    min = Math.max(min, Number.MIN_VALUE);
    max = Math.max(max, min * 1.0000001);
  }

  const dataSpan = dataMax - dataMin;
  let span = max - min;
  if (span >= dataSpan) return { min: dataMin, max: dataMax };

  if (min < dataMin) {
    max += dataMin - min;
    min = dataMin;
  }
  if (max > dataMax) {
    min -= max - dataMax;
    max = dataMax;
  }

  if (min < dataMin) min = dataMin;
  if (max > dataMax) max = dataMax;
  if (max <= min) {
    const center = clamp((min + max) / 2, dataMin, dataMax);
    span = Math.min(dataSpan, Math.max(dataSpan * 1e-9, Number.EPSILON));
    min = clamp(center - span / 2, dataMin, dataMax);
    max = clamp(center + span / 2, dataMin, dataMax);
  }
  return { min, max };
}

function windowedPoints(points: Array<[number, number]>, minX: number, maxX: number): Array<[number, number]> {
  if (!points.length) return [];
  const min = Math.min(minX, maxX);
  const max = Math.max(minX, maxX);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return points;

  const start = lowerBoundPoint(points, min);
  const end = upperBoundPoint(points, max);
  const from = Math.max(0, start - 1);
  const to = Math.min(points.length, end + 1);
  return points.slice(from, to);
}

function lowerBoundPoint(points: Array<[number, number]>, x: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid][0] < x) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBoundPoint(points: Array<[number, number]>, x: number): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid][0] <= x) low = mid + 1;
    else high = mid;
  }
  return low;
}

function downsamplePreserveExtremes(points: Array<[number, number]>, maxPoints: number): Array<[number, number]> {
  if (points.length <= maxPoints || maxPoints < 8) return points;
  const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 4));
  const bucketSize = points.length / bucketCount;
  const result: Array<[number, number]> = [points[0]];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = Math.max(1, Math.floor(bucket * bucketSize));
    const end = Math.min(points.length - 1, Math.floor((bucket + 1) * bucketSize));
    if (end <= start) continue;

    let minPoint = points[start];
    let maxPoint = points[start];
    for (let index = start + 1; index < end; index += 1) {
      const point = points[index];
      if (point[1] < minPoint[1]) minPoint = point;
      if (point[1] > maxPoint[1]) maxPoint = point;
    }

    const candidates = uniquePoints([points[start], minPoint, maxPoint, points[end - 1]]);
    candidates.sort((a, b) => a[0] - b[0]);
    for (const point of candidates) {
      const last = result[result.length - 1];
      if (!last || last[0] !== point[0] || last[1] !== point[1]) result.push(point);
    }
  }

  const lastPoint = points[points.length - 1];
  const last = result[result.length - 1];
  if (!last || last[0] !== lastPoint[0] || last[1] !== lastPoint[1]) result.push(lastPoint);
  return result.length > maxPoints ? result.slice(0, maxPoints - 1).concat(lastPoint) : result;
}

function uniquePoints(points: Array<[number, number]>): Array<[number, number]> {
  const seen = new Set<string>();
  const result: Array<[number, number]> = [];
  for (const point of points) {
    const key = `${point[0]}\u0000${point[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(point);
  }
  return result;
}

function interpolateSeriesValue(points: Array<[number, number]>, x: number): number | null {
  if (!points.length) return null;
  if (x < points[0][0] || x > points[points.length - 1][0]) return null;
  if (x === points[0][0]) return points[0][1];
  let low = 1;
  let high = points.length - 1;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid][0] < x) low = mid + 1;
    else high = mid;
  }
  const left = points[low - 1];
  const right = points[low];
  if (!right || right[0] === left[0]) return left[1];
  const ratio = (x - left[0]) / (right[0] - left[0]);
  return left[1] + (right[1] - left[1]) * ratio;
}

function cloneView(view: ViewState): ViewState {
  return {
    xMin: view.xMin,
    xMax: view.xMax,
    y: new Map([...view.y.entries()].map(([key, value]) => [key, { ...value }])),
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

function formatInteger(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("zh-CN") : "0";
}

function labelForAnalysis(type: string): string {
  if (type === "ac") return "AC";
  if (type === "dc") return "DC Sweep";
  return "Transient";
}

function formatAxisValue(value: number, unit: string): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (unit === "Hz") return scaleUnit(value, [["GHz", 1e9], ["MHz", 1e6], ["kHz", 1e3], ["Hz", 1]]);
  if (unit === "s") return scaleUnit(value, [["s", 1], ["ms", 1e-3], ["us", 1e-6], ["ns", 1e-9], ["ps", 1e-12]]);
  if (unit === "V") return scaleUnit(value, [["kV", 1e3], ["V", 1], ["mV", 1e-3], ["uV", 1e-6]]);
  if (unit === "A") return scaleUnit(value, [["A", 1], ["mA", 1e-3], ["uA", 1e-6], ["nA", 1e-9]]);
  const formatted = abs >= 100000 || (abs > 0 && abs < 0.0001) ? value.toExponential(4) : Number(value.toPrecision(5)).toString();
  return unit ? `${formatted} ${unit}` : formatted;
}

function scaleUnit(value: number, units: Array<[string, number]>): string {
  const abs = Math.abs(value);
  const selected = units.find(([, factor]) => abs >= factor) ?? units[units.length - 1];
  const scaled = value / selected[1];
  return `${Number(scaled.toPrecision(5)).toString()} ${selected[0]}`;
}

function makeAxisLabelFormatter(unit: string, scale: AxisScale, min?: number, max?: number): (value: number) => string {
  return (value: number) => formatAxisTickValue(value, unit, scale, min, max);
}

function formatAxisTickValue(value: number, unit: string, scale: AxisScale, min?: number, max?: number): string {
  if (!Number.isFinite(value)) return "";
  if (scale === "log") return formatAxisValue(value, unit);

  const unitGroup = unitScaleGroup(unit);
  if (!unitGroup) {
    return `${formatSignificant(value)}${unit ? ` ${unit}` : ""}`;
  }

  const selected = selectAxisUnit(unitGroup, min, max, value);
  const factor = selected[1];
  const scaledValue = value / factor;
  return `${formatSignificant(scaledValue)} ${selected[0]}`;
}

function unitScaleGroup(unit: string): Array<[string, number]> | null {
  if (unit === "Hz") return [["GHz", 1e9], ["MHz", 1e6], ["kHz", 1e3], ["Hz", 1]];
  if (unit === "s") return [["s", 1], ["ms", 1e-3], ["us", 1e-6], ["ns", 1e-9], ["ps", 1e-12]];
  if (unit === "V") return [["kV", 1e3], ["V", 1], ["mV", 1e-3], ["uV", 1e-6]];
  if (unit === "A") return [["A", 1], ["mA", 1e-3], ["uA", 1e-6], ["nA", 1e-9]];
  return null;
}

function selectAxisUnit(units: Array<[string, number]>, min?: number, max?: number, value = 0): [string, number] {
  const span = visibleSpan(min, max);
  const reference = Math.max(Math.abs(min ?? 0), Math.abs(max ?? 0), Math.abs(value), span);
  return units.find(([, factor]) => reference >= factor) ?? units[units.length - 1];
}

function visibleSpan(min?: number, max?: number): number {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return NaN;
  return Math.abs(Number(max) - Number(min));
}

function axisMinInterval(unit: string, scale: AxisScale, min?: number, max?: number): number | undefined {
  if (scale === "log") return undefined;
  const span = visibleSpan(min, max);
  const unitGroup = unitScaleGroup(unit);
  const selected = unitGroup ? selectAxisUnit(unitGroup, min, max) : null;
  const factor = selected?.[1] ?? 1;
  const reference = Math.max(Math.abs(Number(min) || 0), Math.abs(Number(max) || 0), Number.isFinite(span) ? span : 0);
  const scaledReference = reference / factor;
  const resolution = significantResolution(scaledReference || span / factor || 1);
  return resolution * factor;
}

function readableAxisRange(range: { min: number; max: number } | undefined, unit: string, scale: AxisScale): { min: number; max: number } {
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
    return scale === "log" ? { min: 1, max: 10 } : { min: 0, max: 1 };
  }
  if (scale === "log") return range;

  const min = Math.min(range.min, range.max);
  const max = Math.max(range.min, range.max);
  const span = Math.max(max - min, 0);
  const minInterval = axisMinInterval(unit, scale, min, max) ?? 0;
  if (!Number.isFinite(minInterval) || minInterval <= 0) return { min, max };

  const minimumSpan = minInterval * 2;
  let nextMin = min;
  let nextMax = max;
  if (span < minimumSpan) {
    const center = (min + max) / 2;
    nextMin = center - minimumSpan / 2;
    nextMax = center + minimumSpan / 2;
  }

  nextMin = Math.floor(nextMin / minInterval) * minInterval;
  nextMax = Math.ceil(nextMax / minInterval) * minInterval;
  if (nextMax - nextMin < minimumSpan) {
    nextMin -= minInterval;
    nextMax += minInterval;
  }

  return { min: normalizeAxisBoundary(nextMin), max: normalizeAxisBoundary(nextMax) };
}

function constrainAxisView(range: { min: number; max: number }, unit: string, scale: AxisScale): { min: number; max: number } {
  if (scale === "log") return range;
  const min = Math.min(range.min, range.max);
  const max = Math.max(range.min, range.max);
  const minInterval = axisMinInterval(unit, scale, min, max) ?? 0;
  const minimumSpan = minInterval * 2;
  if (!Number.isFinite(minimumSpan) || minimumSpan <= 0 || max - min >= minimumSpan) {
    return { min, max };
  }
  const center = (min + max) / 2;
  return {
    min: normalizeAxisBoundary(center - minimumSpan / 2),
    max: normalizeAxisBoundary(center + minimumSpan / 2),
  };
}

function normalizeAxisBoundary(value: number): number {
  if (!Number.isFinite(value)) return value;
  const abs = Math.abs(value);
  if (abs === 0 || abs >= 1e8 || abs < 1e-8) return value;
  return Number(value.toPrecision(14));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function significantResolution(reference: number, digits = 5): number {
  const abs = Math.abs(reference);
  if (!Number.isFinite(abs) || abs === 0) return 10 ** (1 - digits);
  return 10 ** (Math.floor(Math.log10(abs)) - digits + 1);
}

function formatSignificant(value: number): string {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  if (abs >= 100000 || (abs > 0 && abs < 0.0001)) return value.toExponential(4);
  return Number(value.toPrecision(5)).toString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] || char));
}
