import type { EChartsOption } from "echarts";
import { t } from "../../shared/i18n";
import { axisDisplayUnit, clamp, formatWaveformValue } from "../components/chart-kit/axis-format";
import { ChartBase } from "../components/chart-kit/echarts-chart-base";
import { CursorLineGraphics } from "../components/chart-kit/cursor-graphics";
import { CursorInspectorPanel } from "../components/chart-kit/cursor-inspector";
import { CHART_LEGEND_ICON, colorAt } from "../components/chart-kit/palette";
import { panRange, zoomRange } from "../components/chart-kit/view-scale";
import { escapeHtml } from "../utils/format";
import type { LogicRow } from "../../features/logic/logic-data";

const CATEGORIES_PER_ROW = 14;
/** 行内状态类目偏移（从下到上：0、U、1）。 */
const ROW_LOW_OFFSET = 2;
const ROW_UNCERTAIN_OFFSET = 7;
const ROW_HIGH_OFFSET = 12;

const CURSOR_TOP = 44;

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

/** 鼠标事件。 */
function localPoint(el: HTMLElement, event: MouseEvent): { x: number; y: number } {
	const rect = el.getBoundingClientRect();
	return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

/**
 * 逻辑分析图：纵向排列各逻辑节点的 0/1 时序，共享横轴缩放平移。
 */
export class LogicChart extends ChartBase {
	private rows: LogicRow[] = [];
	private hiddenRowIds = new Set<string>();
	private legendHiddenRowIds = new Set<string>();
	private cursorX: number | null = null;
	private cursorDragging = false;
	private panState: PanState | null = null;
	private view: ViewState = { xMin: 0, xMax: 1 };
	/** 跟随模式鼠标位置 */
	private hoverX: number | null = null;
	/** 游标模式数值面板。 */
	private readonly inspector: CursorInspectorPanel;
	private readonly cursorGraphics: CursorLineGraphics;

	constructor(el: HTMLElement) {
		super(el, null, null, { fallbackWidth: 600, fallbackHeight: 400 });
		this.inspector = new CursorInspectorPanel({
			container: el,
			onCommit: (value) => this.commitInspectorX(value),
			inputAriaLabel: t("chart.inspectorAria"),
		});
		this.cursorGraphics = new CursorLineGraphics(this.chart, "logic-cursor-line", "logic-cursor-handle");
		el.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
		el.addEventListener("mousedown", (event) => this.handleMouseDown(event));
		// 捕获阶段抢在 ECharts 提示框之前更新鼠标位置,否则读数慢一拍。
		el.addEventListener("mousemove", (event) => this.handleChartMouseMove(event), { capture: true });
		el.addEventListener("mouseleave", () => this.handleChartMouseLeave());
		window.addEventListener("mousemove", (event) => this.handleWindowMouseMove(event));
		window.addEventListener("mouseup", (event) => this.handleWindowMouseUp(event));
		this.chart.on("legendselectchanged", (event: any) => this.handleLegendSelectionChanged(event));
		this.renderEmpty();
	}

	setRows(rows: LogicRow[]): void {
		// 按节点序号自然排序（小→大）：图例自左向右、行自上而下都与序号一致。
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

	setVisibleRowIds(ids: Iterable<string> | null): void {
		const selected = ids ? new Set(ids) : null;
		this.hiddenRowIds = new Set(selected
			? this.rows.filter((row) => !selected.has(row.id)).map((row) => row.id)
			: []);
		this.fit();
	}

	fit(): void {
		if (!this.rows.length) return;
		const bounds = this.dataXBounds();
		this.view = { xMin: bounds.min, xMax: bounds.max };
		this.render();
	}

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
		this.inspector.hide();
		this.renderEmpty();
	}

	protected hasContent(): boolean {
		return this.rows.length > 0;
	}

	protected onCursorModeChanged(): void {
		if (this.cursorMode === "cursor") {
			this.ensureCursorPosition();
			this.updateCursorAtX();
		}
		else {
			this.cursorDragging = false;
			this.el.style.cursor = "";
			this.hideCursorMarkers();
		}
	}

	protected afterResize(): void {
		if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateCursorAtX();
	}

	protected onLocaleChanged(): void {
		this.inspector.setAriaLabel(t("chart.inspectorAria"));
	}

	private handleLegendSelectionChanged(event: { selected?: Record<string, boolean> }): void {
		if (!event?.selected) return;
		const nextHidden = new Set<string>();
		for (const row of this.getRenderableRows()) {
			if (event.selected[row.name] === false) nextHidden.add(row.id);
		}
		this.legendHiddenRowIds = nextHidden;
		if (this.cursorMode === "cursor") {
			this.ensureCursorPosition();
			this.updateCursorAtX();
		}
	}

	protected renderEmpty(): void {
		this.renderEmptyChart(t("chart.logicEmpty"));
	}

	protected render(): void {
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
				data: rows.map((row) => ({ name: row.name, icon: CHART_LEGEND_ICON })),
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
				axisPointer: { type: "none", snap: false },
				formatter: (params) => this.formatTooltip(Array.isArray(params) ? params : [params]),
			},
			series: [
				...rows.map((row) => this.buildRowSeries(row, rows, categories)),
				this.buildCursorSeries(),
			],
		};
		this.chart.setOption(option, true);
		// 整图重建会清掉自绘的跟随虚线，按最近鼠标位置重画。
		if (this.cursorMode === "follow" && this.hoverX !== null) this.updateFollowLine();
		if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateCursorAtX();
		else this.inspector.hide();
	}

	private buildRowSeries(
		row: LogicRow,
		allRows: LogicRow[],
		categories: ReturnType<LogicChart["buildCategories"]>,
	) {
		const base = categories.rowIndexMap.get(row.id) ?? 0;
		const showLine = this.displayMode !== "points";
		const showPoints = this.displayMode !== "line" && row.points.length <= 6000;
		const color = colorAt(allRows.indexOf(row));
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

	/** 游标点位 */
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
		const x = this.cursorMode === "cursor" && this.cursorX !== null
			? this.cursorX
			: this.hoverX ?? Number(visibleParams[0].axisValue);
		const unit = axisDisplayUnit("s", this.view.xMin, this.view.xMax, x);
		const xText = unit.label ? `${formatWaveformValue(x / unit.factor)} ${unit.label}` : formatWaveformValue(x / unit.factor);
		let html = `<div class="chart-tip"><b>${escapeHtml(t("chart.logicXLabel"))}: ${xText}</b><br/>`;
		for (const row of this.getDisplayedRows()) {
			const y = this.logicValueAtX(row.points, x);
			if (y === null) continue;
			const index = renderable.indexOf(row);
			html += `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${colorAt(index)};margin-right:4px"></span>${escapeHtml(row.name)}: <b>${logicLabel(y)}</b><br/>`;
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
		// 按当前锚点(游标或鼠标)补画交点,避免缩放/平移后圆点消失。
		if (this.cursorMode === "cursor" && this.cursorX !== null) this.updateDotsAtX(this.cursorX);
		else if (this.cursorMode === "follow" && this.hoverX !== null) this.updateDotsAtX(this.hoverX);
	}

	private handleWheel(event: WheelEvent): void {
		if (!this.rows.length) return;
		const bounds = this.plotBounds();
		const localX = event.clientX - this.el.getBoundingClientRect().left;
		const ratio = clamp((localX - bounds.left) / bounds.width, 0, 1);
		const scale = event.deltaY < 0 ? 0.84 : 1.16;
		event.preventDefault();
		const focus = this.view.xMin + (this.view.xMax - this.view.xMin) * ratio;
		const zoomed = zoomRange(this.view.xMin, this.view.xMax, focus, scale, false);
		this.view = this.constrainView({ xMin: zoomed.min, xMax: zoomed.max });
		this.applyView();
	}

	private handleMouseDown(event: MouseEvent): void {
		if (event.button !== 0) return;
		const point = localPoint(this.el, event);
		if (this.cursorMode === "cursor") {
			// 游标模式。
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

	/** 游标手柄(顶部三角形)命中判定。 */
	private isCursorHandleHit(localX: number, localY: number): boolean {
		if (this.cursorMode !== "cursor" || this.cursorX === null) return false;
		const pixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX));
		return this.cursorGraphics.isHandleHit(localX, localY, pixel, CURSOR_TOP);
	}

	/**
	 * 跟随模式
	 */
	private handleChartMouseMove(event: MouseEvent): void {
		if (this.cursorMode !== "follow" || !this.rows.length) return;
		const point = localPoint(this.el, event);
		const rawX = this.xValueAtPixel(point.x);
		this.hoverX = this.displayMode !== "line" ? this.snapXToNearestSample(rawX) : rawX;
		this.updateFollowLine();
		this.updateDotsAtX(this.hoverX);
	}

	private handleChartMouseLeave(): void {
		if (this.cursorMode !== "follow") return;
		this.hoverX = null;
		this.clearFollowLine();
		this.chart.setOption({ series: [{ id: "logic-cursor", data: [] }] }, false);
	}

	/** 点/线点模式把 x 吸附到各行最近采样点。 */
	private snapXToNearestSample(x: number): number {
		let best = x;
		let bestDistance = Number.POSITIVE_INFINITY;
		for (const row of this.getDisplayedRows()) {
			for (const point of row.points) {
				const distance = Math.abs(point[0] - x);
				if (distance < bestDistance) {
					bestDistance = distance;
					best = point[0];
				}
			}
		}
		return best;
	}

	/**
	 * 跟随模式的灰色虚线
	 */
	private updateFollowLine(): void {
		if (this.hoverX === null) return;
		const bounds = this.plotBounds();
		const pixel = Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.hoverX));
		if (!Number.isFinite(pixel)) return;
		this.chart.setOption({
			graphic: [{
				id: "logic-follow-line",
				type: "line",
				silent: true,
				z: 9999,
				invisible: false,
				shape: { x1: pixel, y1: 34, x2: pixel, y2: bounds.bottom },
				style: { stroke: "rgba(0, 0, 0, 0.24)", lineWidth: 1, lineDash: [5, 4] },
			}],
		}, false);
	}

	private clearFollowLine(): void {
		this.chart.setOption({
			graphic: [{ id: "logic-follow-line", type: "line", silent: true, invisible: true, shape: { x1: 0, y1: 0, x2: 0, y2: 0 } }],
		}, false);
	}

	private handleWindowMouseMove(event: MouseEvent): void {
		// 游标拖动。
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
		const panned = panRange(this.panState.view.xMin, this.panState.view.xMax, dx / this.panState.bounds.width, false, "x");
		this.view = this.constrainView({ xMin: panned.min, xMax: panned.max });
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

	/** 游标与波形交点 */
	private updateDotsAtX(x: number): void {
		if (!this.rows.length) return;
		const renderable = this.getRenderableRows();
		const data = this.getDisplayedRows().map((row) => {
			const y = this.logicValueAtX(row.points, x);
			if (y === null) return null;
			const index = renderable.indexOf(row);
			return {
				value: [x, this.mapLogicValueToCategory(y, index, renderable.length)],
				itemStyle: { color: colorAt(index) },
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
		this.cursorGraphics.draw({ pixel, top: CURSOR_TOP, bottom: this.plotBounds().bottom });
	}

	private hideCursorLine(): void {
		this.cursorGraphics.hide();
	}

	private hideCursorMarkers(): void {
		this.cursorX = null;
		this.hideCursorLine();
		this.chart.setOption({ series: [{ id: "logic-cursor", data: [] }] }, false);
		this.inspector.hide();
	}

	private commitInspectorX(value: number): void {
		if (this.cursorMode !== "cursor") return;
		const target = clamp(value, Math.min(this.dataXBounds().min, 0), this.dataXBounds().max);
		if (target < this.view.xMin || target > this.view.xMax) {
			const span = this.view.xMax - this.view.xMin;
			this.view = this.constrainView({ xMin: target - span / 2, xMax: target + span / 2 });
			this.applyView();
		}
		this.cursorX = target;
		this.updateCursorAtX();
	}

	/** 游标模式数值面板内容 */
	private updateInspector(): void {
		if (this.cursorMode !== "cursor" || this.cursorX === null || !this.rows.length) {
			this.inspector.hide();
			return;
		}
		const renderable = this.getRenderableRows();
		const rows = this.getDisplayedRows().flatMap((row) => {
			const y = this.logicValueAtX(row.points, this.cursorX as number);
			if (y === null) return [];
			return [{ id: row.id, index: renderable.indexOf(row), name: row.name, value: logicLabel(y) }];
		});
		const displayUnit = axisDisplayUnit("s", this.view.xMin, this.view.xMax, this.cursorX);
		const bounds = this.dataXBounds();
		this.inspector.update({
			axisName: t("chart.logicXLabel"),
			inputTitle: t("chart.inspectorInputTitle", t("chart.logicXLabel"), displayUnit.label || t("chart.inspectorUnitFallback")),
			unit: { label: displayUnit.label, factor: displayUnit.factor },
			bounds: { min: bounds.min, max: bounds.max, isLog: false },
			x: this.cursorX,
			rows: rows.map((row) => ({ id: row.id, color: colorAt(row.index), text: `${row.name}: ${row.value}` })),
			position: {
				pixel: Number(this.chart.convertToPixel({ xAxisIndex: 0 }, this.cursorX)),
				boundsLeft: this.plotBounds().left,
				boundsRight: this.plotBounds().right,
				boundsTop: CURSOR_TOP,
				boundsBottom: this.plotBounds().bottom,
				fixedTop: CURSOR_TOP + 8,
			},
		});
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

	private getRenderableRows(): LogicRow[] {
		return this.rows.filter((row) => !this.hiddenRowIds.has(row.id));
	}

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
			// 纵向"楼层"轴 0 号楼层在最底部:序号大的节点排底部,小的排顶部。
			const base = (rows.length - 1 - index) * CATEGORIES_PER_ROW;
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
		return points.map(([x, y]) => {
			const offset = y === 1 ? ROW_HIGH_OFFSET : y === 0 ? ROW_LOW_OFFSET : ROW_UNCERTAIN_OFFSET;
			return [x, base + offset];
		});
	}

	private mapLogicValueToCategory(y: number, rowIndex: number, rowCount: number): number {
		// 与 buildCategories 相同的楼层反转：序号小的节点排顶部（画布从上往下画）。
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

/** 节点名自然排序。 */
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

// 兼容导出。
export const rowColor = colorAt;
