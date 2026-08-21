import { t } from "../../shared/i18n";
import { escapeHtml } from "../format";
import { probeNameCandidates } from "../../shared/probe-names";
import type { ProbeTarget } from "../../shared/probe";
import type { SimulationResult, WaveformTrace } from "../../shared/waveform";
import {
	analogToLogicRow,
	collectLogicTraces,
	filterAnalogResult,
	resolveProbeThresholds,
	type LogicRow,
} from "../../features/logic/logic-data";
import { rowColor } from "./chart";
import type { LogicChart } from "./chart";
import type { WaveformController } from "../waveform/controller";

export interface LogicControllerElements {
	viewTabs: HTMLElement;
	waveformTab: HTMLButtonElement;
	histogramTab: HTMLButtonElement;
	logicTab: HTMLButtonElement;
	waveformContext: HTMLElement;
	waveformElement: HTMLElement;
	logicContext: HTMLElement;
	logicElement: HTMLElement;
	logicFitButton: HTMLButtonElement;
	logicTraceSelectButton: HTMLButtonElement;
	logicDisplayButton: HTMLButtonElement;
	logicDisplayLabel: HTMLElement;
	logicCursorModeButton: HTMLButtonElement;
	logicCursorModeLabel: HTMLElement;
	dialog: HTMLElement;
	closeDialogButton: HTMLButtonElement;
	traceList: HTMLElement;
	traceCount: HTMLElement;
	selectAllButton: HTMLButtonElement;
	clearSelectionButton: HTMLButtonElement;
	invertSelectionButton: HTMLButtonElement;
	applySelectionButton: HTMLButtonElement;
	cancelSelectionButton: HTMLButtonElement;
}

/**
 * 逻辑分析图控制器：把 SimulationResult 分流为模拟（波形图）与逻辑（逻辑分析图），
 * 并处理逻辑探针指向模拟节点时的阈值转换。
 */
export class LogicController {
	private result: SimulationResult | null = null;
	private probeNodes: ProbeTarget[] = [];
	private hasLogicData = false;
	private viewActive = false;
	private dialogSelectedRowIds = new Set<string>();

	constructor(
		private readonly elements: LogicControllerElements,
		private readonly chart: LogicChart,
		private readonly waveform: WaveformController,
		private readonly appendLog: (message: string) => void,
	) {
		// 逻辑分析 tab 切换。waveformTab 切回波形视图；MC 下由 MC 接管同一 tab，
		// 两个 handler 都触发时行为一致（显示波形图、隐藏逻辑图）。
		this.elements.logicTab.addEventListener("click", () => this.activateView(true));
		this.elements.waveformTab.addEventListener("click", () => this.activateView(false));
		this.elements.logicFitButton.addEventListener("click", () => this.chart.fit());
		this.elements.logicTraceSelectButton.addEventListener("click", () => this.showTraceSelection());
		this.elements.logicDisplayButton.addEventListener("click", () => {
			this.elements.logicDisplayLabel.textContent = this.chart.cycleDisplayMode();
		});
		this.elements.logicCursorModeButton.addEventListener("click", () => {
			this.elements.logicCursorModeLabel.textContent = this.chart.cycleCursorMode();
		});
		this.elements.closeDialogButton.addEventListener("click", () => this.closeTraceSelection());
		this.elements.cancelSelectionButton.addEventListener("click", () => this.closeTraceSelection());
		this.elements.selectAllButton.addEventListener("click", () => this.setDialogChecks("all"));
		this.elements.clearSelectionButton.addEventListener("click", () => this.setDialogChecks("none"));
		this.elements.invertSelectionButton.addEventListener("click", () => this.setDialogChecks("invert"));
		this.elements.applySelectionButton.addEventListener("click", () => this.applyTraceSelection());
		this.elements.dialog.addEventListener("mousedown", (event) => {
			if (event.target === this.elements.dialog) this.closeTraceSelection();
		});
	}

	/** 在波形图与逻辑分析图之间切换显示（与 MC 的波形/直方图切换同款）。 */
	activateView(showLogic: boolean): void {
		this.viewActive = showLogic;
		this.elements.waveformTab.classList.toggle("active", !showLogic);
		this.elements.logicTab.classList.toggle("active", showLogic);
		this.elements.waveformTab.setAttribute("aria-selected", String(!showLogic));
		this.elements.logicTab.setAttribute("aria-selected", String(showLogic));
		this.elements.waveformContext.classList.toggle("hidden", showLogic);
		this.elements.logicContext.classList.toggle("hidden", !showLogic);
		this.elements.waveformElement.classList.toggle("hidden", showLogic);
		this.elements.logicElement.classList.toggle("hidden", !showLogic);
		if (showLogic) {
			this.elements.logicDisplayLabel.textContent = this.chart.getDisplayLabel();
			this.elements.logicCursorModeLabel.textContent = this.chart.getCursorModeLabel();
		}
		// 逻辑图画布首次显示时尺寸可能为 0，等布局完成后强制 resize。
		window.setTimeout(() => this.chart.resize(), 0);
		window.setTimeout(() => { this.waveform.resizeCharts(); this.chart.resize(); }, 30);
	}

	/** 分流：从 result 抽出逻辑 trace 给逻辑图，剩余模拟 result 交给波形图。 */
	present(result: SimulationResult, probeNodes: ProbeTarget[]): void {
		this.result = result;
		this.probeNodes = probeNodes;
		this.hasLogicData = false;

		const logicTraces = collectLogicTraces(result);
		const converted: LogicRow[] = [];

		// 1. 原生逻辑 trace 直接进逻辑图
		for (const trace of logicTraces) {
			converted.push({
				id: trace.id,
				name: displayLogicName(trace),
				points: trace.points,
				sourceTraceId: trace.id,
			});
			this.hasLogicData = true;
		}

		// 2. 逻辑探针指向模拟节点：按阈值转逻辑值。节点已有原生 digital trace 时
		//    直接由步骤 1 覆盖，不再走转换/报错。
		for (const probe of this.probeNodes) {
			if (probe.probeType !== 1) continue;
			if (findLogicTraceForNode(result, probe.node)) continue;
			const thresholds = resolveProbeThresholds(probe);
			if (!thresholds) {
				this.appendLog(t("logic.missingThreshold", probe.node));
				continue;
			}
			const analogTrace = findAnalogTraceForNode(result, probe.node);
			if (!analogTrace) continue;
			const row = analogToLogicRow(analogTrace, probe, thresholds.highLevel, thresholds.lowLevel);
			if (row.points.length) {
				converted.push(row);
				this.hasLogicData = true;
			}
		}

		// 3. 模拟探针指向数字节点：XSPICE 数字节点只有逻辑状态（0/1/U），没有真实电压，
		//    电平映射会造成数据不确定（3.3V 输入可能被映成 5V），不予筛选和渲染，日志报错。
		//    混模节点既有 v() 波形又有事件数据（如 PULSE 源驱动的门输入）时，电压真实存在，
		//    正常按模拟显示，不报错。
		const analogResult = filterAnalogResult(result);
		for (const probe of this.probeNodes) {
			if (probe.probeType !== undefined && probe.probeType !== 0) continue;
			if (!findAnalogTraceForNode(result, probe.node) && findLogicTraceForNode(result, probe.node)) {
				this.appendLog(t("logic.analogProbeOnDigitalNode", probe.node));
			}
		}

		// 4. 逻辑 trace 分给逻辑图，模拟 result 给波形图；有探针时默认只显示探针对应行
		//（与波形图 defaultTraceSelection 的 preferred → ≤6 全显 → 截前 6 一致）。
		this.chart.setRows(converted);
		const preferredRowIds = preferredLogicRowIds(converted, this.probeNodes);
		if (preferredRowIds) this.chart.setVisibleRowIds(preferredRowIds);
		this.updateTabVisibility();
		// 波形图首选筛选只认模拟探针（数字探针归逻辑图，不泄漏到波形图）。
		this.waveform.present(filterPreferredToAnalogProbes(analogResult, this.probeNodes));
	}

	clear(): void {
		this.result = null;
		this.hasLogicData = false;
		this.viewActive = false;
		this.chart.clear();
		this.updateTabVisibility();
		this.activateView(false);
	}

	refreshLocale(): void {
		if (this.result) this.updateTabVisibility();
		this.chart.refreshLocale();
	}

	setRunning(_running: boolean): void {
		// 逻辑分析图不参与运行态控制。
	}

	/** 打开曲线选择弹窗，列出逻辑行供勾选。 */
	private showTraceSelection(): void {
		const rows = this.chart.getRows();
		if (!rows.length) return;
		this.dialogSelectedRowIds = new Set(this.chart.getVisibleRowIds());
		this.renderTraceSelection(rows);
		this.elements.dialog.classList.remove("hidden");
	}

	private closeTraceSelection(): void {
		this.elements.dialog.classList.add("hidden");
		this.dialogSelectedRowIds = new Set();
	}

	private renderTraceSelection(rows: LogicRow[]): void {
		// 色板颜色与画布一致：按布局中（曲线选择保留）的位置取色，
		// 未选中的行也用"选中后将会得到"的位置，勾选回画布时颜色不跳变。
		const renderableIds = new Set(this.chart.getVisibleRowIds());
		const positionOf = new Map<string, number>();
		let next = 0;
		for (const row of rows) {
			if (renderableIds.has(row.id)) positionOf.set(row.id, next++);
		}
		for (const row of rows) {
			if (!positionOf.has(row.id)) positionOf.set(row.id, next++);
		}
		this.elements.traceList.innerHTML = rows.map((row) => `
			<label class="trace-option">
				<input type="checkbox" value="${escapeHtml(row.id)}" ${this.dialogSelectedRowIds.has(row.id) ? "checked" : ""} />
				<span class="trace-swatch" style="--trace-color:${escapeHtml(rowColor(positionOf.get(row.id) ?? 0))}"></span>
				<span class="trace-name">${escapeHtml(row.name)}</span>
			</label>
		`).join("");
		this.elements.traceList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
			input.addEventListener("change", () => {
				if (input.checked) this.dialogSelectedRowIds.add(input.value);
				else this.dialogSelectedRowIds.delete(input.value);
				this.updateTraceCount();
			});
		});
		this.updateTraceCount();
	}

	private setDialogChecks(mode: "all" | "none" | "invert"): void {
		const rows = this.chart.getRows();
		for (const row of rows) {
			if (mode === "all") this.dialogSelectedRowIds.add(row.id);
			if (mode === "none") this.dialogSelectedRowIds.delete(row.id);
			if (mode === "invert") {
				if (this.dialogSelectedRowIds.has(row.id)) this.dialogSelectedRowIds.delete(row.id);
				else this.dialogSelectedRowIds.add(row.id);
			}
		}
		this.renderTraceSelection(this.chart.getRows());
	}

	private applyTraceSelection(): void {
		const selected = this.dialogSelectedRowIds;
		if (!selected.size) {
			this.appendLog(t("log.selectAtLeastOne"));
			return;
		}
		this.chart.setVisibleRowIds(selected);
		this.closeTraceSelection();
		this.appendLog(t("log.tracesSelected", selected.size));
	}

	private updateTraceCount(): void {
		const rows = this.chart.getRows();
		this.elements.traceCount.textContent = t("dialog.selected", this.dialogSelectedRowIds.size, rows.length);
		this.elements.applySelectionButton.disabled = this.dialogSelectedRowIds.size === 0;
	}

	/**
	 * 控制分析视图 tab 的显隐（按探针组合 + 逻辑数据有无）：
	 * - 只有逻辑探针：只显示逻辑图（隐藏波形 tab）
	 * - 只有模拟探针 / 无逻辑数据：只显示波形图（隐藏 tab 容器）
	 * - 混合探针 / 无探针且有逻辑数据：tab 切换两个视图都可用
	 */
	private updateTabVisibility(): void {
		const hasDigitalProbe = this.probeNodes.some((probe) => probe.probeType === 1);
		const hasAnalogProbe = this.probeNodes.some((probe) => probe.probeType !== 1);
		if (!this.hasLogicData) {
			// 无逻辑数据：隐藏整个 tab 容器，恢复 histogram tab（MC 需要它）。
			this.elements.viewTabs.classList.add("hidden");
			this.elements.histogramTab.classList.remove("hidden");
			this.elements.logicTab.classList.add("hidden");
			this.activateView(false);
			return;
		}
		if (hasDigitalProbe && !hasAnalogProbe) {
			// 只有逻辑探针：波形图没有默认内容，直接进逻辑视图并隐藏波形 tab。
			this.viewActive = true;
			this.elements.viewTabs.classList.remove("hidden");
			this.elements.waveformTab.classList.add("hidden");
			this.elements.logicTab.classList.remove("hidden");
			this.elements.histogramTab.classList.add("hidden");
			this.activateView(true);
			return;
		}
		// 混合探针 / 无探针：显示 tab 容器，两个视图都可用，histogram 隐藏（标准分析无直方图）。
		this.elements.viewTabs.classList.remove("hidden");
		this.elements.waveformTab.classList.remove("hidden");
		this.elements.logicTab.classList.remove("hidden");
		this.elements.histogramTab.classList.add("hidden");
		this.activateView(this.viewActive);
	}
}

function displayLogicName(trace: WaveformTrace): string {
	return trace.name.replace(/\s+digital$/i, "");
}

/**
 * 有数字探针时返回探针对应的逻辑行 id 集合（首选默认显示）；
 * 无数字探针返回 null（走 LogicRow 全量/截前 6 的默认规则，同波形图）。
 * 行名可能是 "39"（原生 digital trace）或 "v(39) (L)"（模拟转逻辑），
 * 用 probeNameCandidates 归一化后按节点名匹配。只认数字探针：
 * 模拟探针归波形图，不能泄漏进逻辑视图。
 */
function preferredLogicRowIds(
	rows: LogicRow[],
	probeNodes: ProbeTarget[],
): string[] | null {
	const wanted = new Set<string>();
	for (const probe of probeNodes) {
		if (probe.probeType !== 1) continue;
		for (const candidate of probeNameCandidates(probe.node)) wanted.add(candidate);
	}
	if (!wanted.size) return null;

	const ids = rows
		.filter((row) => {
			const candidates = [
				...probeNameCandidates(row.name.replace(/\s+\(L\)$/i, "")),
				...probeNameCandidates(row.sourceTraceId),
			];
			return candidates.some((name) => wanted.has(name));
		})
		.map((row) => row.id);
	return ids.length ? ids : null;
}

function sameNode(name: string, node: string): boolean {
	// trace 名可能是 "V(40)"/"40 digital"/"v(39) (L)"，探针节点是 "40"：
	// 用 probeNameCandidates 归一化后比较，避免字符串直比漏匹配。
	const wanted = new Set(probeNameCandidates(node));
	return probeNameCandidates(name.replace(/\s+digital$/i, "").replace(/\s+\(L\)$/i, ""))
		.some((candidate) => wanted.has(candidate));
}

function findAnalogTraceForNode(result: SimulationResult, node: string): WaveformTrace | null {
	for (const dataset of result.datasets) {
		const trace = dataset.traces.find((item) => item.axisId === "voltage" && sameNode(item.name, node));
		if (trace) return trace;
	}
	return null;
}

function findLogicTraceForNode(result: SimulationResult, node: string): WaveformTrace | null {
	for (const dataset of result.datasets) {
		const trace = dataset.traces.find((item) => item.axisId === "digital" && sameNode(item.name, node));
		if (trace) return trace;
	}
	return null;
}

/**
 * 波形图首选 trace 只保留模拟探针（probeType 0/undefined）命中的：
 * preferredTraceIdsByDataset 由全部探针生成，数字探针的命中会让波形图
 * 也显示该节点，违反"数字探针不泄漏到模拟视图"。无模拟探针时不筛选。
 */
function filterPreferredToAnalogProbes(
	result: SimulationResult,
	probeNodes: ProbeTarget[],
): SimulationResult {
	const analogNodes = probeNodes.filter((probe) => probe.probeType !== 1);
	if (!analogNodes.length) return { ...result, preferredTraceIdsByDataset: {} };
	const wanted = new Set<string>();
	for (const probe of analogNodes) {
		for (const candidate of probeNameCandidates(probe.node)) wanted.add(candidate);
	}
	if (!wanted.size) return { ...result, preferredTraceIdsByDataset: {} };
	const preferred: Record<string, string[]> = {};
	for (const dataset of result.datasets) {
		const ids = dataset.traces
			.filter((trace) => trace.axisId !== "digital" && traceMatchesWanted(trace, wanted))
			.map((trace) => trace.id);
		if (ids.length) preferred[dataset.id] = ids;
	}
	return { ...result, preferredTraceIdsByDataset: preferred };
}

function traceMatchesWanted(trace: WaveformTrace, wanted: Set<string>): boolean {
	const names = probeNameCandidates(trace.name);
	names.push(...probeNameCandidates(trace.id));
	const baseName = trace.name.replace(/\s+(gain|phase)$/i, "");
	if (baseName !== trace.name) names.push(...probeNameCandidates(baseName));
	return names.some((name) => wanted.has(name));
}
