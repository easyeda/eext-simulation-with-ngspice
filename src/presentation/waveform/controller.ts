import type { SimulationResult, WaveformDataset, WaveformTrace } from "../../shared/waveform";
import { t } from "../../shared/i18n";
import type { AnalysisOverlayHost, AnalysisTraceChoiceController } from "../analysis-presentation";
import { downloadTextFile } from "../utils/download";
import { exportWaveformDatasets } from "./download";
import { analysisTitle, escapeHtml, formatInteger, formatNumber } from "../utils/format";
import { filterAnalogResult } from "../../features/logic/logic-data";
import { traceColorAt, WaveformChart } from "./chart";
import { extent } from "./series-data";
import { mountDataTable, type DataTableRow } from "../components/data-table";

export interface WaveformControllerElements {
	resultTabs: HTMLElement;
	fitButton: HTMLButtonElement;
	traceSelectButton: HTMLButtonElement;
	displayButton: HTMLButtonElement;
	displayLabel: HTMLElement;
	cursorModeButton: HTMLButtonElement;
	cursorModeLabel: HTMLElement;
	exportButton: HTMLButtonElement;
	dialog: HTMLElement;
	closeDialogButton: HTMLButtonElement;
	traceList: HTMLElement;
	filterInput: HTMLInputElement;
	traceCount: HTMLElement;
	selectAllButton: HTMLButtonElement;
	clearSelectionButton: HTMLButtonElement;
	invertSelectionButton: HTMLButtonElement;
	applySelectionButton: HTMLButtonElement;
	cancelSelectionButton: HTMLButtonElement;
	dcGroupsTab: HTMLButtonElement;
	dcGroupsTable: HTMLElement;
}

export interface WaveformControllerDependencies {
	activeTraceChoiceController: () => AnalysisTraceChoiceController | null;
	appendLog: (message: string) => void;
	resizeCharts: () => void;
	exportBaseName: (result: SimulationResult) => string;
	/** 可选。双源 DC 结果就绪时激活底部"扫描分组"面板。 */
	activateDcGroupsPanel?: () => void;
}

/** 统一管理标准波形、分析叠加波形、曲线选择和波形导出。 */
export class WaveformController implements AnalysisOverlayHost {
	private result: SimulationResult | null = null;
	private activeDatasetId: string | null = null;
	private traceSelection = new Map<string, Set<string>>();
	private dialogDataset: WaveformDataset | null = null;
	private dialogSelectedTraceIds = new Set<string>();
	private running = false;
	/** 上一次已输出过 DC 扫描问题日志的结果标识（恢复旧结果时避免重复提示）。 */
	private lastDcIssueKey = "";
	/** 双源 DC 当前高亮的分组号（0 起）；null = 未高亮。 */
	private selectedGroupIndex: number | null = null;

	constructor(
		private readonly chart: WaveformChart,
		private readonly elements: WaveformControllerElements,
		private readonly dependencies: WaveformControllerDependencies,
	) {}

	install(): void {
		const elements = this.elements;
		elements.fitButton.addEventListener("click", () => this.chart.fit());
		elements.traceSelectButton.addEventListener("click", () => this.showTraceDialog());
		elements.displayButton.addEventListener("click", () => {
			elements.displayLabel.textContent = this.chart.cycleDisplayMode();
		});
		elements.cursorModeButton.addEventListener("click", () => {
			elements.cursorModeLabel.textContent = this.chart.cycleCursorMode();
		});
		elements.exportButton.addEventListener("click", () => void this.exportCurrent());
		elements.closeDialogButton.addEventListener("click", () => this.closeTraceDialog());
		elements.cancelSelectionButton.addEventListener("click", () => this.closeTraceDialog());
		elements.selectAllButton.addEventListener("click", () => this.setDialogChecks("all"));
		elements.clearSelectionButton.addEventListener("click", () => this.setDialogChecks("none"));
		elements.invertSelectionButton.addEventListener("click", () => this.setDialogChecks("invert"));
		elements.applySelectionButton.addEventListener("click", () => this.applyTraceSelection());
		elements.dialog.addEventListener("mousedown", (event) => {
			if (event.target === elements.dialog) this.closeTraceDialog();
		});
		elements.filterInput.addEventListener("input", () => this.renderTraceDialog());
		this.updateExportState();
	}

	present(result: SimulationResult): void {
		// 波形图只显示模拟信号曲线（数字信号曲线归逻辑分析图）。
		this.result = localizeSimulationResult(filterAnalogResult(result));
		this.chart.setStaleResult(false);
		this.traceSelection = new Map();
		for (const dataset of this.result.datasets) {
			this.traceSelection.set(dataset.id, this.defaultTraceSelection(dataset, this.result));
		}
		this.renderResultTabs();
		this.activateDataset(this.result.activeDatasetId || this.result.datasets[0]?.id || "");
		this.reportDcSweepIssues();
		if (this.dcGroupDataset()) this.dependencies.activateDcGroupsPanel?.();
	}

	clear(): void {
		this.result = null;
		this.activeDatasetId = null;
		this.traceSelection = new Map();
		this.selectedGroupIndex = null;
		this.elements.resultTabs.innerHTML = "";
		this.elements.resultTabs.classList.add("hidden");
		this.closeTraceDialog();
		this.chart.setDataset(null);
		this.chart.setHighlightedTraceIds(null);
		this.chart.setStaleResult(false);
		this.hideDcGroupsPanel();
		this.updateExportState();
	}

	markStaleResult(): void {
		this.chart.setStaleResult(true);
	}

	setDataset(dataset: WaveformDataset | null, opts?: { keepView?: boolean }): void {
		if (!dataset) {
			this.clear();
			return;
		}
		this.result = { datasets: [dataset], activeDatasetId: dataset.id };
		this.activeDatasetId = dataset.id;
		this.traceSelection = new Map([[dataset.id, new Set(dataset.traces.map((trace) => trace.id))]]);
		this.renderResultTabs();
		this.chart.setVisibleTraceIds(null, false);
		this.chart.setDataset(dataset, { keepView: opts?.keepView === true });
		this.updateExportState();
	}

	getPlotGeometry() {
		return this.chart.getPlotGeometry();
	}

	onChartAfterRender(callback: () => void): () => void {
		return this.chart.onAfterRender(callback);
	}

	getDisplayMode(): "line" | "points" | "both" {
		return this.chart.getDisplayMode();
	}

	getDataset(): WaveformDataset | null {
		return this.result?.datasets.find((dataset) => dataset.id === this.activeDatasetId)
			?? this.result?.datasets[0]
			?? null;
	}

	getResult(): SimulationResult | null {
		return this.result;
	}

	setHighlightedTraceIds(traceIds: string[] | null): void {
		this.chart.setHighlightedTraceIds(traceIds);
	}

	appendLog(message: string): void {
		this.dependencies.appendLog(message);
	}

	resizeCharts(): void {
		this.dependencies.resizeCharts();
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.updateExportState();
	}

	refreshLocale(localizeTitles: boolean): void {
		if (localizeTitles && this.result) {
			for (const dataset of this.result.datasets) {
				dataset.title = analysisTitle(dataset.spiceCommandType);
				// DC 扫描横轴标题按当前语言重排（结果随新语言重新渲染）。
				applyDcSweepAxisTitle(dataset);
			}
		}
		this.renderDcGroupsPanel();
		this.chart.refreshLocale();
		this.elements.displayLabel.textContent = this.chart.getDisplayLabel();
		this.elements.cursorModeLabel.textContent = this.chart.getCursorModeLabel();
		if (this.isTraceDialogOpen() && this.dialogDataset) this.renderTraceDialog();
	}

	queueTraceDialogOpen(): void {
		if (!this.result || this.running) return;
		const open = () => {
			if (!this.result || this.running) return;
			this.showTraceDialog();
			this.chart.resize();
		};
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => requestAnimationFrame(open));
			return;
		}
		window.setTimeout(open, 30);
	}

	isTraceDialogOpen(): boolean {
		return !this.elements.dialog.classList.contains("hidden");
	}

	closeTraceDialog(): void {
		this.elements.dialog.classList.add("hidden");
		this.dialogDataset = null;
		this.dialogSelectedTraceIds = new Set();
	}

	private renderResultTabs(): void {
		const tabs = this.elements.resultTabs;
		if (!this.result || this.result.datasets.length <= 1) {
			tabs.innerHTML = "";
			tabs.classList.add("hidden");
			return;
		}
		tabs.classList.remove("hidden");
		tabs.innerHTML = this.result.datasets.map((dataset) => `
    <button class="result-tab" type="button" data-id="${escapeHtml(dataset.id)}">
      ${escapeHtml(dataset.productAnalysisType.toUpperCase())}
      <span>${escapeHtml(dataset.meta.sourcePlot || dataset.command || dataset.id)}</span>
    </button>
  `).join("");
		tabs.querySelectorAll<HTMLButtonElement>(".result-tab").forEach((button) => {
			button.addEventListener("click", () => this.activateDataset(button.dataset.id || ""));
		});
	}

	private activateDataset(id: string): void {
		if (!this.result) return;
		const dataset = this.result.datasets.find((item) => item.id === id) || this.result.datasets[0] || null;
		this.activeDatasetId = dataset?.id || null;
		const selected = dataset ? this.ensureTraceSelection(dataset) : null;
		this.chart.setVisibleTraceIds(selected, false);
		this.chart.setDataset(dataset);
		this.chart.setHighlightedTraceIds(null);
		this.selectedGroupIndex = null;
		this.elements.displayLabel.textContent = this.chart.getDisplayLabel();
		this.elements.cursorModeLabel.textContent = this.chart.getCursorModeLabel();
		this.elements.resultTabs.querySelectorAll<HTMLElement>(".result-tab").forEach((tab) => {
			tab.classList.toggle("active", tab.dataset.id === dataset?.id);
		});
		this.renderDcGroupsPanel();
		this.updateExportState();
	}

	private defaultTraceSelection(dataset: WaveformDataset, result = this.result): Set<string> {
		const preferred = result?.preferredTraceIdsByDataset?.[dataset.id]
			?.filter((id) => dataset.traces.some((trace) => trace.id === id));
		if (preferred?.length) return new Set(preferred);
		if (dataset.traces.length <= 6) return new Set(dataset.traces.map((trace) => trace.id));
		return new Set(dataset.traces.slice(0, 6).map((trace) => trace.id));
	}

	private ensureTraceSelection(dataset: WaveformDataset): Set<string> {
		const existing = this.traceSelection.get(dataset.id);
		if (existing) return existing;
		const next = this.defaultTraceSelection(dataset);
		this.traceSelection.set(dataset.id, next);
		return next;
	}

	private showTraceDialog(datasetId = this.activeDatasetId || undefined): void {
		if (!this.result) {
			this.appendLog(t("log.noResultForSelection"));
			return;
		}
		const controller = this.dependencies.activeTraceChoiceController();
		const choices = controller?.traceChoices() ?? [];
		if (controller && choices.length) {
			this.dialogDataset = this.result.datasets[0] || null;
			this.dialogSelectedTraceIds = new Set([controller.activeTraceChoiceId() || choices[0].id]);
		}
		else {
			const dataset = this.result.datasets.find((item) => item.id === datasetId) || this.result.datasets[0];
			if (!dataset) return;
			this.activeDatasetId = dataset.id;
			this.dialogDataset = dataset;
			this.dialogSelectedTraceIds = new Set(this.ensureTraceSelection(dataset));
		}
		this.elements.filterInput.value = "";
		this.renderTraceDialog();
		this.elements.dialog.classList.remove("hidden");
		this.elements.filterInput.focus();
	}

	private renderTraceDialog(): void {
		if (!this.dialogDataset) return;
		const controller = this.dependencies.activeTraceChoiceController();
		const choices = controller?.traceChoices() ?? [];
		if (controller && choices.length) {
			this.renderAnalysisChoices(choices);
			return;
		}
		this.elements.selectAllButton.classList.remove("hidden");
		this.elements.clearSelectionButton.classList.remove("hidden");
		this.elements.invertSelectionButton.classList.remove("hidden");
		const dataset = this.dialogDataset;
		const traces = this.visibleDialogTraces();
		this.elements.traceList.innerHTML = traces.length ? traces.map((trace) => {
			const traceIndex = dataset.traces.findIndex((item) => item.id === trace.id);
			const color = trace.color || traceColorAt(traceIndex);
			// 双源 DC 分组曲线同名：弹窗里补组标签（"V2=1 V"）区分。
			const metaText = [trace.meta?.groupLabel, trace.unit, t("dialog.samplePoints", formatInteger(trace.points.length))]
				.filter(Boolean).join(" · ");
			return `
    <label class="trace-option">
      <input type="checkbox" value="${escapeHtml(trace.id)}" ${this.dialogSelectedTraceIds.has(trace.id) ? "checked" : ""} />
      <span class="trace-swatch" style="--trace-color:${escapeHtml(color)}"></span>
      <span class="trace-name">${escapeHtml(trace.name)}</span>
      <span class="trace-meta">${escapeHtml(metaText)}</span>
    </label>
  `;
		}).join("") : `<div class="trace-empty">${escapeHtml(t("dialog.noMatchingTrace"))}</div>`;
		this.elements.traceList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
			input.addEventListener("change", () => {
				if (input.checked) this.dialogSelectedTraceIds.add(input.value);
				else this.dialogSelectedTraceIds.delete(input.value);
				this.updateTraceDialogCount();
			});
		});
		this.updateTraceDialogCount();
	}

	private renderAnalysisChoices(choices: ReturnType<AnalysisTraceChoiceController["traceChoices"]>): void {
		const keyword = this.elements.filterInput.value.trim().toLowerCase();
		const options = keyword
			? choices.filter((option) => option.label.toLowerCase().includes(keyword) || option.traceName.toLowerCase().includes(keyword))
			: choices;
		this.elements.selectAllButton.classList.add("hidden");
		this.elements.clearSelectionButton.classList.add("hidden");
		this.elements.invertSelectionButton.classList.add("hidden");
		this.elements.traceList.innerHTML = options.length ? options.map((option, index) => `
    <label class="trace-option mc-probe-option">
      <input type="radio" name="analysisProbe" value="${escapeHtml(option.id)}" ${this.dialogSelectedTraceIds.has(option.id) ? "checked" : ""} />
      <span class="trace-swatch" style="--trace-color:${escapeHtml(traceColorAt(index))}"></span>
      <span class="trace-name">${escapeHtml(option.label)}</span>
      <span class="trace-meta">${escapeHtml(option.traceName)} · ${escapeHtml(option.description)}</span>
    </label>
  `).join("") : `<div class="trace-empty">${escapeHtml(t("dialog.noMatchingProbe"))}</div>`;
		this.elements.traceList.querySelectorAll<HTMLInputElement>('input[name="analysisProbe"]').forEach((input) => {
			input.addEventListener("change", () => {
				this.dialogSelectedTraceIds = new Set([input.value]);
				this.updateTraceDialogCount();
			});
		});
		this.updateTraceDialogCount();
	}

	private setDialogChecks(mode: "all" | "none" | "invert"): void {
		for (const trace of this.visibleDialogTraces()) {
			if (mode === "all") this.dialogSelectedTraceIds.add(trace.id);
			if (mode === "none") this.dialogSelectedTraceIds.delete(trace.id);
			if (mode === "invert") {
				if (this.dialogSelectedTraceIds.has(trace.id)) this.dialogSelectedTraceIds.delete(trace.id);
				else this.dialogSelectedTraceIds.add(trace.id);
			}
		}
		this.renderTraceDialog();
	}

	private applyTraceSelection(): void {
		if (!this.result || !this.activeDatasetId) return;
		const checked = [...this.dialogSelectedTraceIds];
		if (!checked.length) {
			this.appendLog(t("log.selectAtLeastOne"));
			return;
		}
		const controller = this.dependencies.activeTraceChoiceController();
		if (controller?.traceChoices().length) {
			controller.selectTraceChoice(checked[0]);
			this.closeTraceDialog();
			return;
		}
		this.traceSelection.set(this.activeDatasetId, new Set(checked));
		this.chart.setVisibleTraceIds(checked, true);
		this.closeTraceDialog();
		this.appendLog(t("log.tracesSelected", checked.length));
	}

	private updateTraceDialogCount(): void {
		if (!this.dialogDataset) {
			this.elements.traceCount.textContent = t("dialog.selected", 0, 0);
			this.elements.applySelectionButton.disabled = true;
			return;
		}
		const choices = this.dependencies.activeTraceChoiceController()?.traceChoices() ?? [];
		if (choices.length) {
			const selectedCount = this.dialogSelectedTraceIds.size;
			const visibleCount = this.elements.traceList.querySelectorAll('input[name="analysisProbe"]').length;
			this.elements.traceCount.textContent = t("dialog.selectedMatched", selectedCount ? 1 : 0, choices.length, visibleCount);
			this.elements.applySelectionButton.disabled = selectedCount === 0;
			return;
		}
		const visibleCount = this.visibleDialogTraces().length;
		const selectedCount = this.dialogSelectedTraceIds.size;
		const totalCount = this.dialogDataset.traces.length;
		this.elements.traceCount.textContent = this.elements.filterInput.value.trim()
			? t("dialog.selectedMatched", selectedCount, totalCount, visibleCount)
			: t("dialog.selected", selectedCount, totalCount);
		this.elements.applySelectionButton.disabled = selectedCount === 0;
	}

	private visibleDialogTraces(): WaveformTrace[] {
		if (!this.dialogDataset) return [];
		const keyword = this.elements.filterInput.value.trim().toLowerCase();
		if (!keyword) return this.dialogDataset.traces;
		return this.dialogDataset.traces.filter((trace) => `${trace.name} ${trace.unit} ${trace.id}`.toLowerCase().includes(keyword));
	}

	private async exportCurrent(): Promise<void> {
		if (!this.result?.datasets.length) {
			this.appendLog(t("log.noWaveformExport"));
			return;
		}
		// MC 模式：隐形底图数据集的 meta.waveformStore 携带全量波形，导出它（不跨模块）。
		if (this.result.datasets.some((dataset) => dataset.id === "mc-scaffold")) {
			return this.exportScaffoldWaveforms();
		}
		try {
			this.elements.exportButton.disabled = true;
			const exported = await exportWaveformDatasets(this.result.datasets, {
				baseName: this.dependencies.exportBaseName(this.result),
			});
			this.appendLog(t("log.waveformExported", exported.fileName, exported.datasetCount, exported.traceCount));
		}
		catch (error) {
			this.appendLog(t("log.waveformExportFailed", error instanceof Error ? error.message : String(error)));
		}
		finally {
			this.updateExportState();
		}
	}

	/** MC scaffold：把 meta.waveformStore 里的全量波形导出为 CSV（数据随图表走，不跨模块）。 */
	private exportScaffoldWaveforms(): void {
		const dataset = this.result?.datasets.find((item) => item.id === "mc-scaffold");
		const store = dataset?.meta?.waveformStore as {
			getSeries(traceName: string): Array<{ sampleIndex: number; time: Float64Array; values: Float32Array }>;
		} | undefined;
		const traceName = dataset?.meta?.probeTraceName as string | undefined;
		if (!store || !traceName) return;
		const seriesList = store.getSeries(traceName);
		if (!seriesList.length) return;
		const time = seriesList[0].time;
		// 表头用横轴真名：AC=频率(freq)，DC=扫描源，瞬态=time
		const xAxisName = dataset?.xAxis.name?.trim() || "x";
		const xAxisUnit = dataset?.xAxis.unit?.trim();
		const firstHeader = xAxisUnit ? `${xAxisName} (${xAxisUnit})` : xAxisName;
		const count = Math.min(time.length, ...seriesList.map((s) => s.values.length));
		const lines: string[] = [`${firstHeader},${seriesList.map((s) => `#${s.sampleIndex}`).join(",")}`];
		for (let index = 0; index < count; index += 1) {
			const row = [String(time[index])];
			for (const series of seriesList) row.push(String(series.values[index]));
			lines.push(row.join(","));
		}
		downloadTextFile(
			`monte-carlo-waveform-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
			lines.join("\r\n"),
			"text/csv;charset=utf-8",
		);
		this.appendLog(t("log.mcWaveformExported", seriesList.length, count));
	}

	/**
	 * DC 扫描结果的异常提示：
	 * - 双源分组无法确定 → 解析失败提示。
	 * - 数据存在无效点 → 结果不完整提示。
	 * 按 simulationId 去重：失败后恢复旧结果时不会重复输出。
	 */
	private reportDcSweepIssues(): void {
		if (!this.result) return;
		const datasets = this.result.datasets.filter((dataset) => dataset.meta.sweep);
		if (!datasets.length) return;
		const issueKey = datasets.map((dataset) => `${dataset.id}:${dataset.meta.sweep?.groupingOk ? 1 : 0}${dataset.meta.sweep?.incomplete ? 1 : 0}`).join("|");
		if (issueKey === this.lastDcIssueKey) return;
		this.lastDcIssueKey = issueKey;
		if (datasets.some((dataset) => dataset.meta.sweep?.source2 && !dataset.meta.sweep.groupingOk)) {
			this.appendLog(t("dc.parseFailed"));
		}
		if (datasets.some((dataset) => dataset.meta.sweep?.incomplete)) {
			this.appendLog(t("dc.incomplete"));
		}
	}

	/** 双源 DC 结果对应的分组数据集（无则返回 null）。 */
	private dcGroupDataset(): WaveformDataset | null {
		return this.result?.datasets.find((dataset) => dataset.meta.sweep?.source2 && dataset.meta.sweep.groupingOk) ?? null;
	}

	/**
	 * 底部"扫描分组"表（仅双源 DC 显示）：每组一行，列 = 组号、源2值、各测量对象末值/范围。
	 * 点击行 → 画布高亮该组全部曲线、其余置灰。
	 */
	private renderDcGroupsPanel(): void {
		const dataset = this.dcGroupDataset();
		if (!dataset) {
			this.hideDcGroupsPanel();
			return;
		}
		this.elements.dcGroupsTab.classList.remove("hidden");
		mountDataTable(this.elements.dcGroupsTable, {
			columns: dcGroupColumns(dataset),
			rows: dcGroupRows(dataset, this.selectedGroupIndex),
			tableClassName: "wc-table",
			onRowActivate: (rowId) => {
				const groupIndex = Number(rowId);
				if (Number.isFinite(groupIndex)) this.highlightGroup(groupIndex);
			},
		});
	}

	private hideDcGroupsPanel(): void {
		this.elements.dcGroupsTab.classList.add("hidden");
		this.elements.dcGroupsTable.innerHTML = "";
	}

	private highlightGroup(groupIndex: number): void {
		this.selectedGroupIndex = this.selectedGroupIndex === groupIndex ? null : groupIndex;
		const dataset = this.dcGroupDataset();
		const ids = dataset && this.selectedGroupIndex !== null
			? dataset.traces.filter((trace) => trace.meta?.groupIndex === this.selectedGroupIndex).map((trace) => trace.id)
			: null;
		this.setHighlightedTraceIds(this.selectedGroupIndex !== null ? ids : null);
		this.renderDcGroupsPanel();
	}

	private updateExportState(): void {
		this.elements.exportButton.disabled = this.running
			|| !this.result?.datasets.some((dataset) => dataset.traces.length > 0);
	}
}

function localizeSimulationResult(result: SimulationResult): SimulationResult {
	return {
		...result,
		datasets: result.datasets.map((dataset) => {
			const next = { ...dataset, title: analysisTitle(dataset.spiceCommandType) };
			applyDcSweepAxisTitle(next);
			return next;
		}),
	};
}

/**
 * DC 扫描横轴标题：电流源显示"扫描电流 {源1} (A)"，电压源显示"扫描电压 {源1} (V)"。
 * 名称/单位随本次运行的结果冻结（meta.sweep 来自运行时的网表），不随表单变化；
 * 语言切换时经 refreshLocale 重新生成本地化标题。
 */
function applyDcSweepAxisTitle(dataset: WaveformDataset): void {
	const sweep = dataset.meta.sweep;
	if (dataset.spiceCommandType !== "dc" || !sweep?.source1.name) return;
	if (sweep.source1.kind !== "current" && sweep.source1.kind !== "voltage") return;
	dataset.xAxis = {
		...dataset.xAxis,
		name: sweep.source1.kind === "current"
			? t("dc.axis.current", sweep.source1.name)
			: t("dc.axis.voltage", sweep.source1.name),
	};
}

/**
 * 双源 DC"扫描分组"表：每组一行（组号、源2值、各测量对象末值/范围），
 * 行点击高亮对应曲线组（高亮行加 active，经 mountDataTable 绑定）。
 */
function dcGroupColumns(dataset: WaveformDataset): string[] {
	const sweep = dataset.meta.sweep;
	if (!sweep?.source2) return [];
	return [
		t("dc.groupColumn"),
		sweep.source2.name,
		...dcGroupObjectNames(dataset).flatMap((name) => [t("dc.groupEndValue", name), t("dc.groupRange", name)]),
	];
}

function dcGroupObjectNames(dataset: WaveformDataset): string[] {
	return [...new Set(dataset.traces.filter((trace) => trace.meta?.groupIndex !== undefined).map((trace) => trace.name))];
}

function dcGroupRows(dataset: WaveformDataset, selectedGroupIndex: number | null): DataTableRow[] {
	const sweep = dataset.meta.sweep;
	if (!sweep?.source2) return [];
	const grouped = dataset.traces.filter((trace) => trace.meta?.groupIndex !== undefined);
	const objectNames = dcGroupObjectNames(dataset);
	const rows: DataTableRow[] = [];
	for (let groupIndex = 0; groupIndex < sweep.groupCount; groupIndex += 1) {
		const first = grouped.find((trace) => trace.meta?.groupIndex === groupIndex);
		const groupLabel = first?.meta?.groupLabel ?? "";
		const source2Value = groupLabel ? groupLabel.slice(groupLabel.indexOf("=") + 1) : "--";
		const cells = objectNames.flatMap((name) => {
			const trace = grouped.find((item) => item.name === name && item.meta?.groupIndex === groupIndex);
			const [min, max] = extent(trace?.points.map((point) => point[1]) ?? []);
			const lastFinite = trace?.points.filter((point) => Number.isFinite(point[1])).pop()?.[1];
			const unit = trace?.unit ? ` ${trace.unit}` : "";
			const endText = lastFinite === undefined ? "--" : `${formatNumber(lastFinite)}${unit}`;
			const rangeText = Number.isFinite(min) && Number.isFinite(max)
				? `${formatNumber(min)} ~ ${formatNumber(max)}${unit}`
				: "--";
			return [endText, rangeText];
		});
		rows.push({
			id: String(groupIndex),
			className: "wc-run-row",
			active: selectedGroupIndex === groupIndex,
			cells: [String(groupIndex + 1), source2Value, ...cells],
		});
	}
	return rows;
}
