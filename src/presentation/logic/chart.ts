import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import { t } from "../../shared/i18n";
import { axisDisplayUnit, clamp, formatWaveformValue } from "../waveform/axis-format";
import type { LogicRow } from "../../features/logic/logic-data";

/**
 * 每个逻辑行占 14 个类目（从下到上：0 在带 2、U 在带 7、1 在带 12）。
 * 类目轴（boundaryGap）数据点画在带宽中心，0→1 跨度 = (12.5-2.5)/14 = 5/7，
 * 一行 = 全画布 5/7，N 行 = (画布/N)×5/7；跨度中心 0.536，与画布中线差 1/28
 * （538px 画布约 7px），类目带宽中心只能是半带的整数倍，这是最接近居中的取法。
 */
const CATEGORIES_PER_ROW = 14;
/** 行内状态类目偏移（从下到上：0、U、1）。 */
const ROW_LOW_OFFSET = 2;
const ROW_UNCERTAIN_OFFSET = 7;
const ROW_HIGH_OFFSET = 12;

type DisplayMode = "line" | "points" | "both";
type CursorMode = "follow" | "cursor";

interface ViewState {
	xMin: number;
	xMax: number;
}

interface PanState {
	x: number;
	startedAt: number;
	bounds: { left: number; width: number };
	view: ViewState;
	dragging: boolean;
}

/** 鼠标事件 → 画布内局部坐标（与波形图 localPoint 一致）。 */
function localPoint(el: HTMLElement, event: MouseEvent): { x: number; y: number } {
	const rect = el.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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

/**
 * 逻辑分析图：纵向排列各逻辑节点的 0/1 时序，共享横轴缩放平移。
 * 交互与波形图一致：显示模式（线/点/线点）、跟随/游标数值、适应、曲线选择（移除重排）、legend 隐藏。
 */
export class LogicChart {
	private readonly chart: ECharts;
	private rows: LogicRow[] = [];
	/** 曲线选择移除的行（从布局中彻底消失并重排）。 */
	private hiddenRowIds = new Set<string>();
	/** legend 点击隐藏的行（占位不渲染，布局不变）。 */
	private legendHiddenRowIds = new Set<string>();
	private displayMode: DisplayMode = "line";
	private cursorMode: CursorMode = "follow";
	private cursorX: number | null = null;
	/** 游标手柄拖动中。 */
	private cursorDragging = false;
	private panState: PanState | null = null;
	private view: ViewState = { xMin: 0, xMax: 1 };
	/** 跟随模式鼠标所在 x（画交点圆点用）。 */
	private hoverX: number | null = null;
	/** 游标模式数值面板（与波形图 inspector 同款）。 */
	private inspectorEl!: HTMLDivElement;
	private inspectorAxisNameEl!: HTMLSpanElement;
	private inspectorInputEl!: HTMLInputElement;
	private inspectorUnitEl!: HTMLSpanElement;
	private inspectorRowsEl!: HTMLDivElement;
	private inspectorRowElements: Array<{ rowId: string; row: HTMLDivElement; swatch: HTMLSpanElement; value: HTMLSpanElement }> = [];
	private inspectorXFactor = 1;

	constructor(private readonly el: HTMLElement) {
		// #logicChart 初始 hidden，echarts.init 时元素尺寸可能为 0，
		// 给 fallback 尺寸避免画布空白；显示后由 resize() 更新为真实尺寸。
		const width = el.clientWidth || el.offsetWidth || 600;
		const height = el.clientHeight || el.offsetHeight || 400;
		this.chart = echarts.init(el, null, { renderer: "canvas", width, height });
		this.buildInspector();
		el.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
		el.addEventListener("mousedown", (event) => this.handleMouseDown(event));
		// 捕获阶段监听：zrender 的 tooltip（canvas 目标阶段）会在 el 冒泡处理之前
		// 读 hoverX，必须先于它更新，否则 tooltip 数值滞后一拍。
		el.addEventListener("mousemove", (event) => this.handleChartMouseMove(event), { capture: true });
		el.addEventListener("mouseleave", () => this.handleChartMouseLeave());
		window.addEventListener("mousemove", (event) => this.handleWindowMouseMove(event));
		window.addEventListener("mouseup", (event) => this.handleWindowMouseUp(event));
		window.addEventListener("resize", () => this.resize());
		this.chart.on("legendselectchanged", (event: any) => this.handleLegendSelectionChanged(event));
		this.renderEmpty();
	}

	setRows(rows: LogicRow[]): void {
		// 按节点序号自然排序（小→大）：legend 自左向右、行自上而下都与序号一致。
		this.rows = [...rows].sort((a, b) => compareRowNames(a.name, b.name));
		this.hiddenRowIds = new Set([...this.hiddenRowIds].filter((id) => rows.some((row) => row.id === id)));
		this.legendHiddenRowIds = new Set([...this.legendHiddenRowIds].filter((id) => rows.some((row) => row.id === id)));
		if (rows.length) {
			const bounds = this.dataXBounds();
			this.view = { xMin: bounds.min, xMax: bounds.max };
		}
		if (!rows.length) {
			this.renderEmpty();
			return;
		}
		this.render();
	}

	/** 曲线选择：未选中的行从画布移除并重新布局。 */
	setVisibleRowIds(ids: Iterable<string> | null): void {
		const selected = ids ? new Set(ids) : null;
		this.hiddenRowIds = new Set(selected
			? this.rows.filter((row) => !selected.has(row.id)).map((row) => row.id)
			: []);
		this.fit();
	}

	/** 适应窗口：横轴缩放到数据范围。 */
	fit(): void {
		if (!this.rows.length) return;
		const bounds = this.dataXBounds();
		this.view = { xMin: bounds.min, xMax: bounds.max };
		this.render();
	}

	resize(): void {
		// init 时容器可能 hidden（量不到尺寸），echarts.init 拿过显式兜底尺寸后，
		// 无参 resize() 不会重新测量容器，必须传显式宽高（同直方图图表）。
		const width = this.el.clientWidth;
		const height = this.el.clientHeight;
		if (!width || !height) return;
		this.chart.resize({ width, height });
		if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateCursorAtX();
	}

	refreshLocale(): void {
		if (this.rows.length) this.render();
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

	cycleCursorMode(): string {
		this.cursorMode = this.cursorMode === "follow" ? "cursor" : "follow";
		if (this.cursorMode === "cursor") {
			this.ensureCursorPosition();
			this.updateCursorAtX();
		} else {
			this.cursorDragging = false;
			this.el.style.cursor = "";
			this.hideCursorMarkers();
		}
		this.render();
		return t(cursorLabelKeys[this.cursorMode]);
	}

	getCursorModeLabel(): string {
		return t(cursorLabelKeys[this.cursorMode]);
	}

	/** 当前显示的行 id（供曲线选择用，只含布局中的行）。 */
	getVisibleRowIds(): string[] {
		return this.getRenderableRows().map((row) => row.id);
	}

	/** 当前所有行。 */
	getRows(): LogicRow[] {
		return this.rows;
	}

	clear(): void {
		this.rows = [];
		this.hiddenRowIds = new Set();
		this.legendHiddenRowIds = new Set();
		this.cursorX = null;
		this.hoverX = null;
		this.hideInspector();
		this.renderEmpty();
	}

	private handleLegendSelectionChanged(event: { selected?: Record<string, boolean> }): void {
		if (!event?.selected) return;
		const nextHidden = new Set<string>();
		for (const row of this.getRenderableRows()) {
			if (event.selected[row.name] === false) nextHidden.add(row.id);
		}
		this.legendHiddenRowIds = nextHidden;
		// 与波形图一致：legend 隐藏由 ECharts 原生机制处理（series 保留在 option 里），
		// 这里只同步内部状态供游标/数值读取，不触发全量 render 重建。
		if (this.cursorMode === "cursor") {
			this.ensureCursorPosition();
			this.updateCursorAtX();
		}
	}

	private renderEmpty(): void {
		this.chart.setOption({
			backgroundColor: "#f7f8fa",
			xAxis: { show: false },
			yAxis: { show: false },
			series: [],
			graphic: {
				type: "text",
				left: "center",
				top: "middle",
				style: { text: t("chart.logicEmpty"), fill: "#868686", font: "12px Microsoft YaHei" },
			},
		} satisfies EChartsOption, true);
	}

	private render(): void {
		if (this.cursorMode === "cursor") this.ensureCursorPosition();
		const rows = this.getRenderableRows();
		if (!rows.length) {
			this.renderEmpty();
			return;
		}
		const categories = this.buildCategories(rows);
		const option: EChartsOption = {
			backgroundColor: "#ffffff",
			animation: false,
			legend: {
				top: 0,
				type: "scroll",
				itemWidth: 20,
				itemHeight: 12,
				data: rows.map((row) => ({ name: row.name, icon: LOGIC_LEGEND_ICON })),
				selected: Object.fromEntries(rows.map((row) => [row.name, !this.legendHiddenRowIds.has(row.id)])),
				textStyle: { fontSize: 12, color: "#333" },
			},
			grid: { show: true, left: 40, right: 24, top: 34, bottom: 44, borderColor: "#b8c0cc", borderWidth: 1 },
			xAxis: {
				type: "value",
				scale: true,
				min: this.view.xMin,
				max: this.view.xMax,
				axisLabel: { color: "#5f6874", formatter: (value: number) => formatAxisValue(value) },
				axisLine: { onZero: false, lineStyle: { color: "#87909e" } },
				splitLine: { show: true, lineStyle: { color: "#dde2e8" } },
			},
			yAxis: {
				type: "category",
				data: categories.labels,
				boundaryGap: true,
				position: "left",
				axisLabel: {
					color: "#5f6874",
					fontSize: 11,
					interval: (value: number) => categories.labelIndexes.has(value),
				},
				axisLine: { show: true, lineStyle: { color: "#87909e" } },
				splitLine: { show: false },
			},
			tooltip: {
				show: this.cursorMode === "follow",
				trigger: "axis",
				confine: true,
				backgroundColor: "#fff",
				borderColor: "#d9d9d9",
				textStyle: { color: "#333", fontSize: 12 },
				// 纵轴是类目轴（0/U/1），ECharts 默认把类目轴当 tooltip 基准轴：
				// 悬停落在 U 带/分隔带上找不到数据点就没有竖线和 tooltip，落在
				// 0/1 带上只显示那一行。强制以 x 值轴为基准并关闭 snap：
				// 跳变沿数据点间距不均，snap 会把整段画布等宽切成数据点带，
				// 数值与鼠标位置对不上。
				axisPointer: { axis: "x", snap: false, type: "line", lineStyle: { color: "rgba(0,0,0,0.24)", type: "dashed", width: 1 } },
				formatter: (params) => this.formatTooltip(Array.isArray(params) ? params : [params]),
			},
			series: [
				// 与波形图一致：series 用曲线选择后的全部行（不过滤 legend 隐藏），
				// legend 隐藏由 ECharts 原生机制完成，图标不会因 series 缺失而消失。
				...rows.map((row) => this.buildRowSeries(row, rows, categories)),
				this.buildCursorSeries(),
			],
		};
		this.chart.setOption(option, true);
		if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateCursorAtX();
		else this.hideInspector();
	}

	private buildRowSeries(
		row: LogicRow,
		allRows: LogicRow[],
		categories: ReturnType<LogicChart["buildCategories"]>,
	) {
		const base = categories.rowIndexMap.get(row.id) ?? 0;
		const showLine = this.displayMode !== "points";
		const showPoints = this.displayMode !== "line" && row.points.length <= 6000;
		const color = rowColor(allRows.indexOf(row));
		return {
			id: row.id,
			name: row.name,
			type: "line" as const,
			yAxisIndex: 0,
			data: this.mapRowPoints(row.points, base),
			symbol: "circle" as const,
			showSymbol: showPoints,
			symbolSize: showPoints ? 3.5 : 6,
			smooth: false,
			step: false as const,
			lineStyle: { color, width: showLine ? 1.8 : 0, opacity: showLine ? 1 : 0 },
			itemStyle: { color, opacity: 1 },
			emphasis: { disabled: true },
		};
	}

	/** 游标点位 series（游标模式下放当前 x 的各个逻辑点）。 */
	private buildCursorSeries() {
		return {
			id: "logic-cursor",
			name: "__logic_cursor",
			type: "scatter" as const,
			yAxisIndex: 0,
			data: [],
			symbol: "circle" as const,
			symbolSize: 8,
			z: 20,
			silent: true,
			animation: false,
			itemStyle: { borderColor: "#ffffff", borderWidth: 1.5 },
			tooltip: { show: false },
		};
	}

	private formatTooltip(params: Array<Record<string, any>>): string {
		if (!this.rows.length || !params.length) return "";
		const renderable = this.getRenderableRows();
		const visibleParams = params.filter((param) => !String(param.seriesName).startsWith("__logic_cursor"));
		if (!visibleParams.length) return "";
		// param.axisValue 是 snap 到最近数据点的 x（跳变沿间距不均，等宽分带后
		// 数值与鼠标对不上）。优先用 hover 时记录的真实 x 反算，游标模式下用 cursorX。
		const x = this.cursorMode === "cursor" && this.cursorX !== null
			? this.cursorX
			: this.hoverX ?? Number(visibleParams[0].axisValue);
		const unit = axisDisplayUnit("s", this.view.xMin, this.view.xMax, x);
		const xText = unit.label ? `${formatWaveformValue(x / unit.factor)} ${unit.label}` : formatWaveformValue(x / unit.factor);
		let html = `<div class="chart-tip"><b>${escapeHtml(t("chart.logicXLabel"))}: ${xText}</b><br/>`;
		for (const row of this.getDisplayedRows()) {
			const y = this.logicValueAtX(row.points, x);
			if (y === null) continue;
			// 颜色与 legend/series 一致：用布局中的位置。
			const index = renderable.indexOf(row);
			html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${rowColor(index)};margin-right:4px"></span>${escapeHtml(row.name)}: <b>${logicLabel(y)}</b><br/>`;
		}
		return `${html}</div>`;
	}

	private logicValueAtX(points: Array<[number, number]>, x: number): number | null {
		if (!points.length || x < points[0][0] || x > points[points.length - 1][0]) return null;
		for (let i = 0; i < points.length; i += 1) {
			if (points[i][0] >= x) return points[i][1];
		}
		return points[points.length - 1][1];
	}

	private applyView(): void {
		if (!this.rows.length) return;
		const rows = this.getRenderableRows();
		if (!rows.length) return;
		const categories = this.buildCategories(rows);
		this.chart.setOption({
			xAxis: { min: this.view.xMin, max: this.view.xMax },
			series: [
				...rows.map((row) => ({
					id: row.id,
					data: this.mapRowPoints(row.points, categories.rowIndexMap.get(row.id) ?? 0),
				})),
				{ id: "logic-cursor", data: [] },
			],
		});
	}

	private handleWheel(event: WheelEvent): void {
		if (!this.rows.length) return;
		const bounds = this.plotBounds();
		const localX = event.clientX - this.el.getBoundingClientRect().left;
		const ratio = clamp((localX - bounds.left) / bounds.width, 0, 1);
		const scale = event.deltaY < 0 ? 0.84 : 1.16;
		event.preventDefault();
		const focus = this.view.xMin + (this.view.xMax - this.view.xMin) * ratio;
		const next = {
			xMin: focus - (focus - this.view.xMin) * scale,
			xMax: focus + (this.view.xMax - focus) * scale,
		};
		this.view = this.constrainView(next);
		this.applyView();
	}

	private handleMouseDown(event: MouseEvent): void {
		if (event.button !== 0) return;
		const point = localPoint(this.el, event);
		if (this.cursorMode === "cursor") {
			// 游标模式：按住顶部三角形手柄拖动；点击其它位置移动游标。
			if (this.isCursorHandleHit(point.x, point.y)) {
				this.cursorDragging = true;
				this.el.style.cursor = "ew-resize";
			}
			else {
				this.cursorX = this.xValueAtPixel(point.x);
				this.updateCursorAtX();
			}
			event.preventDefault();
			return;
		}
		this.panState = {
			x: point.x,
			startedAt: performance.now(),
			bounds: this.plotBounds(),
			view: { ...this.view },
			dragging: false,
		};
		event.preventDefault();
	}

	/** 跟随模式：鼠标在画布内移动时更新交点圆点（竖线与数值由 tooltip 自身显示）。 */
	private handleChartMouseMove(event: MouseEvent): void {
		if (this.cursorMode !== "follow" || !this.rows.length) return;
		const point = localPoint(this.el, event);
		this.hoverX = this.xValueAtPixel(point.x);
		this.updateDotsAtX(this.hoverX);
	}

	private handleChartMouseLeave(): void {
		if (this.cursorMode !== "follow") return;
		this.hoverX = null;
		this.chart.setOption({ series: [{ id: "logic-cursor", data: [] }] }, false);
	}

	/** 游标手柄（顶部三角形）命中判定，与波形图同款。 */
	private isCursorHandleHit(localX: number, localY: number): boolean {
		if (this.cursorMode !== "cursor" || this.cursorX === null) return false;
		const pixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX));
		const top = 44;
		return Math.abs(localX - pixel) <= 11 && localY >= top - 16 && localY <= top + 8;
	}

	private handleWindowMouseMove(event: MouseEvent): void {
		// 游标拖动：按住三角形手柄拖动改变游标位置。
		if (this.cursorDragging && event.buttons === 1) {
			const point = localPoint(this.el, event);
			this.cursorX = this.xValueAtPixel(point.x);
			this.updateCursorAtX();
			return;
		}
		if (!this.panState || event.buttons !== 1) return;
		const point = localPoint(this.el, event);
		const dx = point.x - this.panState.x;
		if (!this.panState.dragging && performance.now() - this.panState.startedAt < 120 && Math.abs(dx) < 3) return;
		this.panState.dragging = true;
		const span = this.panState.view.xMax - this.panState.view.xMin;
		const next = {
			xMin: this.panState.view.xMin - (dx / this.panState.bounds.width) * span,
			xMax: this.panState.view.xMax - (dx / this.panState.bounds.width) * span,
		};
		this.view = this.constrainView(next);
		this.applyView();
	}

	private handleWindowMouseUp(event: MouseEvent): void {
		if (this.cursorDragging) {
			const point = localPoint(this.el, event);
			this.cursorX = this.xValueAtPixel(point.x);
			this.cursorDragging = false;
			this.el.style.cursor = "ew-resize";
			this.updateCursorAtX();
			return;
		}
		if (!this.panState) return;
		const state = this.panState;
		this.panState = null;
		if (this.cursorMode !== "cursor" || state.dragging) return;
		const point = localPoint(this.el, event);
		this.cursorX = this.xValueAtPixel(point.x);
		this.updateCursorAtX();
	}

	private ensureCursorPosition(): void {
		if (this.cursorX !== null) return;
		this.cursorX = this.view.xMin + (this.view.xMax - this.view.xMin) * 0.5;
	}

	/** 把给定 x 上各行的逻辑值画成交点圆点（跟随/游标模式共用）。
	 *  跟随模式 x=hoverX（随鼠标），游标模式 x=cursorX（固定）。 */
	private updateDotsAtX(x: number): void {
		if (!this.rows.length) return;
		const renderable = this.getRenderableRows();
		const data = this.getDisplayedRows().map((row) => {
			const y = this.logicValueAtX(row.points, x);
			if (y === null) return null;
			const index = renderable.indexOf(row);
			return {
				value: [x, this.mapLogicValueToCategory(y, index, renderable.length)],
				itemStyle: { color: rowColor(index) },
			};
		}).filter((point): point is NonNullable<typeof point> => point !== null);
		this.chart.setOption({ series: [{ id: "logic-cursor", data }] }, false);
	}

	private updateCursorAtX(): void {
		if (!this.rows.length || this.cursorX === null) return;
		this.updateDotsAtX(this.cursorX);
		this.updateCursorLine();
		this.updateInspector();
	}

	private updateCursorLine(): void {
		if (!this.rows.length || this.cursorMode !== "cursor" || this.cursorX === null) {
			this.hideCursorLine();
			return;
		}
		const pixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX));
		if (!Number.isFinite(pixel)) {
			this.hideCursorLine();
			return;
		}
		const top = 44;
		// 线 + 顶部三角形手柄（可拖动），与波形图同款。invisible 显式写，合并更新按字段存在性取值。
		this.chart.setOption({
			graphic: [
				{
					id: "logic-cursor-line",
					type: "line",
					silent: true,
					z: 10000,
					invisible: false,
					shape: { x1: pixel, y1: top, x2: pixel, y2: this.plotBounds().bottom },
					style: { stroke: "#d32029", lineWidth: 1.5, lineDash: [5, 4] },
				},
				{
					id: "logic-cursor-handle",
					type: "polygon",
					silent: true,
					z: 10001,
					invisible: false,
					shape: { points: [[pixel - 7, top - 12], [pixel + 7, top - 12], [pixel, top]] },
					style: { fill: "#d32029", stroke: "#ffffff", lineWidth: 1 },
				},
			],
		}, false);
	}

	private hideCursorLine(): void {
		this.chart.setOption({
			graphic: [
				{
					id: "logic-cursor-line",
					type: "line",
					invisible: true,
					silent: true,
					shape: { x1: 0, y1: 0, x2: 0, y2: 0 },
				},
				{
					id: "logic-cursor-handle",
					type: "polygon",
					invisible: true,
					silent: true,
					shape: { points: [[0, 0], [0, 0], [0, 0]] },
				},
			],
		}, false);
	}

	private hideCursorMarkers(): void {
		this.cursorX = null;
		this.hideCursorLine();
		this.chart.setOption({ series: [{ id: "logic-cursor", data: [] }] }, false);
		this.hideInspector();
	}

	/** 游标模式数值面板 DOM（复用波形图 inspector 样式）。 */
	private buildInspector(): void {
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
		this.inspectorAxisNameEl = this.inspectorEl.querySelector(".waveform-inspector-axis") as HTMLSpanElement;
		this.inspectorInputEl = this.inspectorEl.querySelector(".waveform-inspector-input") as HTMLInputElement;
		this.inspectorUnitEl = this.inspectorEl.querySelector(".waveform-inspector-unit") as HTMLSpanElement;
		this.inspectorRowsEl = this.inspectorEl.querySelector(".waveform-inspector-rows") as HTMLDivElement;
		for (const eventName of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "wheel"]) {
			this.inspectorEl.addEventListener(eventName, (event) => event.stopPropagation());
		}
		this.inspectorInputEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.commitInspectorX();
				this.inspectorInputEl.select();
			}
			else if (event.key === "Escape") {
				event.preventDefault();
				this.inspectorInputEl.blur();
			}
		});
		this.inspectorInputEl.addEventListener("focus", () => requestAnimationFrame(() => this.inspectorInputEl.select()));
		this.inspectorInputEl.addEventListener("click", () => this.inspectorInputEl.select());
		this.el.appendChild(this.inspectorEl);
	}

	/** 游标 x 输入提交（与波形图同款：按显示单位换算回秒）。 */
	private commitInspectorX(): void {
		const parsed = Number(this.inspectorInputEl.value);
		if (!Number.isFinite(parsed)) return;
		const value = parsed * this.inspectorXFactor;
		const bounds = this.dataXBounds();
		this.cursorX = clamp(value, Math.min(bounds.min, 0), bounds.max);
		this.updateCursorAtX();
	}

	/** 游标模式数值面板内容与位置。 */
	private updateInspector(): void {
		if (this.cursorMode !== "cursor" || this.cursorX === null || !this.rows.length) {
			this.hideInspector();
			return;
		}
		const renderable = this.getRenderableRows();
		const rows = this.getDisplayedRows().flatMap((row) => {
			const y = this.logicValueAtX(row.points, this.cursorX as number);
			if (y === null) return [];
			return [{ rowId: row.id, index: renderable.indexOf(row), name: row.name, value: logicLabel(y) }];
		});
		const displayUnit = axisDisplayUnit("s", this.view.xMin, this.view.xMax, this.cursorX);
		const unitChanged = this.inspectorXFactor !== displayUnit.factor;
		this.inspectorXFactor = displayUnit.factor;
		this.inspectorAxisNameEl.textContent = `${t("chart.logicXLabel")}:`;
		this.inspectorUnitEl.textContent = displayUnit.label;
		this.inspectorInputEl.title = t("chart.inspectorInputTitle", t("chart.logicXLabel"), displayUnit.label || t("chart.inspectorUnitFallback"));
		if (document.activeElement !== this.inspectorInputEl || unitChanged) {
			this.inspectorInputEl.value = formatWaveformValue(this.cursorX / displayUnit.factor);
		}

		const structureChanged = rows.length !== this.inspectorRowElements.length
			|| rows.some((row, index) => row.rowId !== this.inspectorRowElements[index]?.rowId);
		if (structureChanged) {
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
				return { rowId: row.rowId, row: rowEl, swatch, value };
			});
			this.inspectorRowsEl.replaceChildren(fragment);
		}
		rows.forEach((row, index) => {
			const elements = this.inspectorRowElements[index];
			elements.swatch.style.backgroundColor = rowColor(row.index);
			elements.value.textContent = `${row.name}: ${row.value}`;
		});
		this.inspectorEl.classList.remove("hidden");

		const pixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX));
		const bounds = this.plotBounds();
		const panelWidth = this.inspectorEl.offsetWidth || 228;
		const gap = 10;
		const left = pixel + panelWidth + gap > bounds.right
			? Math.max(bounds.left + 6, pixel - panelWidth - gap)
			: Math.min(bounds.right - panelWidth, Math.max(bounds.left + 6, pixel + gap));
		// 与波形图一致：面板贴绘图区顶部（grid 顶 44 + 8 间距）。
		const top = 52;
		this.inspectorEl.style.left = `${left}px`;
		this.inspectorEl.style.top = `${top}px`;
	}

	private hideInspector(): void {
		this.inspectorEl?.classList.add("hidden");
	}

	private constrainView(next: ViewState): ViewState {
		const dataMin = this.dataXBounds().min;
		const dataMax = this.dataXBounds().max;
		if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMax <= dataMin) return next;
		let min = Math.min(next.xMin, next.xMax);
		let max = Math.max(next.xMin, next.xMax);
		const span = max - min;
		const dataSpan = dataMax - dataMin;
		if (span >= dataSpan) return { xMin: dataMin, xMax: dataMax };
		if (min < dataMin) { max += dataMin - min; min = dataMin; }
		if (max > dataMax) { min -= max - dataMax; max = dataMax; }
		if (min < dataMin) min = dataMin;
		if (max > dataMax) max = dataMax;
		return { xMin: min, xMax: max };
	}

	private dataXBounds(): { min: number; max: number } {
		let minimum = Number.POSITIVE_INFINITY;
		let maximum = Number.NEGATIVE_INFINITY;
		for (const row of this.getRenderableRows()) {
			for (const point of row.points) {
				if (!Number.isFinite(point[0])) continue;
				minimum = Math.min(minimum, point[0]);
				maximum = Math.max(maximum, point[0]);
			}
		}
		if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return { min: 0, max: 1 };
		return { min: minimum, max: maximum };
	}

	/** 布局中的行（曲线选择保留的）。 */
	private getRenderableRows(): LogicRow[] {
		return this.rows.filter((row) => !this.hiddenRowIds.has(row.id));
	}

	/** 实际渲染的行（曲线选择保留且 legend 未隐藏）。 */
	private getDisplayedRows(): LogicRow[] {
		return this.getRenderableRows().filter((row) => !this.legendHiddenRowIds.has(row.id));
	}

	private buildCategories(rows: LogicRow[]): {
		labels: string[];
		labelIndexes: Set<number>;
		rowIndexMap: Map<string, number>;
	} {
		const labels: string[] = [];
		const labelIndexes = new Set<number>();
		const rowIndexMap = new Map<string, number>();
		rows.forEach((row, index) => {
			// category 轴 index 0 在底部：序号大的行 base 小（排底部），序号小的行排顶部，
			// 与 legend 自左向右（小→大）的排列方向一致。
			const base = (rows.length - 1 - index) * CATEGORIES_PER_ROW;
			// 行内 7 带：0、空、U、空、空、1、空（数据点画在带中心，0→1 跨 5/7）。
			const rowLabels = Array.from({ length: CATEGORIES_PER_ROW }, (_, slot) => (
				slot === ROW_LOW_OFFSET ? "0"
					: slot === ROW_UNCERTAIN_OFFSET ? "U"
						: slot === ROW_HIGH_OFFSET ? "1"
							: ""
			));
			labels.push(...rowLabels);
			labelIndexes.add(base + ROW_LOW_OFFSET);
			labelIndexes.add(base + ROW_UNCERTAIN_OFFSET);
			labelIndexes.add(base + ROW_HIGH_OFFSET);
			rowIndexMap.set(row.id, base);
		});
		return { labels, labelIndexes, rowIndexMap };
	}

	private mapRowPoints(points: Array<[number, number]>, base: number): Array<[number, number]> {
		// 逻辑值 0/0.5/1 → 行内类目偏移：0→0（底部）、U→2、1→5（顶部）
		return points.map(([x, y]) => {
			const offset = y === 1 ? ROW_HIGH_OFFSET : y === 0 ? ROW_LOW_OFFSET : ROW_UNCERTAIN_OFFSET;
			return [x, base + offset];
		});
	}

	private mapLogicValueToCategory(y: number, rowIndex: number, rowCount: number): number {
		// 与 buildCategories 相同的反转：序号小的行排顶部。
		const base = (rowCount - 1 - rowIndex) * CATEGORIES_PER_ROW;
		const offset = y === 1 ? ROW_HIGH_OFFSET : y === 0 ? ROW_LOW_OFFSET : ROW_UNCERTAIN_OFFSET;
		return base + offset;
	}

	private xValueAtPixel(localX: number): number {
		const bounds = this.plotBounds();
		const ratio = clamp((localX - bounds.left) / bounds.width, 0, 1);
		return this.view.xMin + (this.view.xMax - this.view.xMin) * ratio;
	}

	private plotBounds(): { left: number; right: number; bottom: number; width: number } {
		const left = 40;
		const right = Math.max(41, this.el.clientWidth - 24);
		const bottom = Math.max(45, this.el.clientHeight - 24);
		return { left, right, bottom, width: Math.max(1, right - left) };
	}
}

function formatAxisValue(value: number): string {
	if (!Number.isFinite(value)) return "";
	if (value === 0) return "0";
	if (Math.abs(value) >= 1e-4) return Number(value.toPrecision(5)).toString();
	return value.toExponential(3);
}

/** 节点名自然排序："40" < "45" < "100"（字符串序会得到 "100" < "40"）。 */
function compareRowNames(a: string, b: string): number {
	const ma = /^(\d+)(.*)$/.exec(a.trim());
	const mb = /^(\d+)(.*)$/.exec(b.trim());
	if (ma && mb) {
		const byNumber = Number(ma[1]) - Number(mb[1]);
		if (byNumber !== 0) return byNumber;
		return ma[2].localeCompare(mb[2], undefined, { numeric: true });
	}
	return a.localeCompare(b, undefined, { numeric: true });
}

function logicLabel(value: number): string {
	if (value === 1) return "1";
	if (value === 0) return "0";
	return "U";
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[char] || char));
}

const LOGIC_ROW_PALETTE = ["#1890ff", "#fa8c16", "#13a8a8", "#52c41a", "#722ed1", "#d73843", "#096dd9", "#d48806"];
const LOGIC_LEGEND_ICON = "path://M0 5 L20 5 L20 7 L0 7 Z M10 2 A4 4 0 1 0 10 10 A4 4 0 1 0 10 2 Z";

export function rowColor(index: number): string {
	return LOGIC_ROW_PALETTE[Math.max(0, index) % LOGIC_ROW_PALETTE.length];
}
