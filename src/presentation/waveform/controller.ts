import type { SimulationResult, WaveformDataset, WaveformTrace } from "../../shared/waveform";
import { t } from "../../shared/i18n";
import type { AnalysisOverlayHost, AnalysisTraceChoiceController } from "../analysis-presentation";
import { exportWaveformDatasets } from "../download";
import { analysisTitle, escapeHtml, formatInteger } from "../format";
import { filterAnalogResult } from "../../features/logic/logic-data";
import { traceColorAt, WaveformChart } from "./chart";

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
}

export interface WaveformControllerDependencies {
	activeTraceChoiceController: () => AnalysisTraceChoiceController | null;
	appendLog: (message: string) => void;
	resizeCharts: () => void;
	exportBaseName: (result: SimulationResult) => string;
}

/** 统一管理标准波形、分析叠加波形、曲线选择和波形导出。 */
export class WaveformController implements AnalysisOverlayHost {
	private result: SimulationResult | null = null;
	private activeDatasetId: string | null = null;
	private traceSelection = new Map<string, Set<string>>();
	private dialogDataset: WaveformDataset | null = null;
	private dialogSelectedTraceIds = new Set<string>();
	private running = false;

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
		// 波形图只显示模拟 trace（数字 trace 归逻辑分析图）。
		this.result = localizeSimulationResult(filterAnalogResult(result));
		this.traceSelection = new Map();
		for (const dataset of this.result.datasets) {
			this.traceSelection.set(dataset.id, this.defaultTraceSelection(dataset, this.result));
		}
		this.renderResultTabs();
		this.activateDataset(this.result.activeDatasetId || this.result.datasets[0]?.id || "");
	}

	clear(): void {
		this.result = null;
		this.activeDatasetId = null;
		this.traceSelection = new Map();
		this.elements.resultTabs.innerHTML = "";
		this.elements.resultTabs.classList.add("hidden");
		this.closeTraceDialog();
		this.chart.setDataset(null);
		this.chart.setHighlightedTraceIds(null);
		this.updateExportState();
	}

	setDataset(dataset: WaveformDataset | null): void {
		if (!dataset) {
			this.clear();
			return;
		}
		this.result = { datasets: [dataset], activeDatasetId: dataset.id };
		this.activeDatasetId = dataset.id;
		this.traceSelection = new Map([[dataset.id, new Set(dataset.traces.map((trace) => trace.id))]]);
		this.renderResultTabs();
		this.chart.setVisibleTraceIds(null, false);
		this.chart.setDataset(dataset);
		this.updateExportState();
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
			for (const dataset of this.result.datasets) dataset.title = analysisTitle(dataset.spiceCommandType);
		}
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
		this.elements.displayLabel.textContent = this.chart.getDisplayLabel();
		this.elements.cursorModeLabel.textContent = this.chart.getCursorModeLabel();
		this.elements.resultTabs.querySelectorAll<HTMLElement>(".result-tab").forEach((tab) => {
			tab.classList.toggle("active", tab.dataset.id === dataset?.id);
		});
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
			return `
    <label class="trace-option">
      <input type="checkbox" value="${escapeHtml(trace.id)}" ${this.dialogSelectedTraceIds.has(trace.id) ? "checked" : ""} />
      <span class="trace-swatch" style="--trace-color:${escapeHtml(color)}"></span>
      <span class="trace-name">${escapeHtml(trace.name)}</span>
      <span class="trace-meta">${escapeHtml(trace.unit)} · ${escapeHtml(t("dialog.samplePoints", formatInteger(trace.points.length)))}</span>
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

	private updateExportState(): void {
		this.elements.exportButton.disabled = this.running
			|| !this.result?.datasets.some((dataset) => dataset.traces.length > 0);
	}
}

function localizeSimulationResult(result: SimulationResult): SimulationResult {
	return {
		...result,
		datasets: result.datasets.map((dataset) => ({
			...dataset,
			title: analysisTitle(dataset.spiceCommandType),
		})),
	};
}
