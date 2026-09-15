import type {
	AnalysisOverlayHost,
	AnalysisTraceChoice,
	AnalysisTraceChoiceController,
} from "../analysis-presentation";
import { escapeHtml, formatInteger, formatNumber, measurementLabelWithUnit, normalizeMeasurementId, prettyMeasurementId } from "../format";
import { t } from "../../shared/i18n";
import type { ProbeTarget } from "../../shared/probe";
import type { WaveformDataset, WaveformTrace } from "../../shared/waveform";
import type { McWaveformStore } from "../../features/monte-carlo/waveform-store";
import type { MonteCarloMeasurementConfig, MonteCarloResult, MonteCarloSampleProgress, MonteCarloSampleResult, MonteCarloSummary } from "../../features/monte-carlo/types";
import { downloadTextFile } from "../download";
import { buildHistogramMeasurements, type HistogramMeasurement } from "../../features/monte-carlo/histogram";
import { MonteCarloHistogramChart, type HistogramYAxisMode } from "./histogram-chart";
import { McOverlayCanvas } from "./overlay-canvas";
import {
	buildMonteCarloProbeOptions,
	buildMonteCarloProbeOptionsFromTemplate,
	buildMonteCarloOverlayMetaFromStore,
	type MonteCarloProbeOption,
} from "../../features/monte-carlo/view-model";
import {
	collectSampleMeasurementIds,
	monteCarloResultToCsv,
} from "../../features/monte-carlo/report";

type AnalysisView = "waveform" | "histogram";

export interface MonteCarloControllerElements {
	app: HTMLElement;
	status: HTMLElement;
	exportButton: HTMLButtonElement;
	summaryTab: HTMLButtonElement;
	samplesTab: HTMLButtonElement;
	summaryTable: HTMLElement;
	sampleTable: HTMLElement;
	viewTabs: HTMLElement;
	waveformTab: HTMLButtonElement;
	histogramTab: HTMLButtonElement;
	waveformContext: HTMLElement;
	histogramContext: HTMLElement;
	waveformElement: HTMLElement;
	histogramElement: HTMLElement;
	histogramFitButton: HTMLButtonElement;
	measurementSelect: HTMLSelectElement;
	countButton: HTMLButtonElement;
	percentButton: HTMLButtonElement;
	specToggle: HTMLInputElement;
}

export class MonteCarloController implements AnalysisTraceChoiceController {
	private result: MonteCarloResult | null = null;
	private measurementConfigs: MonteCarloMeasurementConfig[] = [];
	private probeOptions: MonteCarloProbeOption[] = [];
	private activeProbeId = "";
	private highlightedSampleIndex: number | null = null;
	private histogramMeasurements: HistogramMeasurement[] = [];
	private activeHistogramMeasurementId = "";
	private running = false;
	private overlayCanvas: McOverlayCanvas | null = null;
	private detachAfterRender: (() => void) | null = null;
	private streamStore: McWaveformStore | null = null;
	private streamTemplate: WaveformDataset | null = null;
	private scaffoldDataset: WaveformDataset | null = null;
	private streamTotal = 0;
	private streamQueued = false;
	private streamNextRenderAt = 0;

	private readonly app: HTMLElement;
	private readonly status: HTMLElement;
	private readonly exportButton: HTMLButtonElement;
	private readonly summaryTab: HTMLButtonElement;
	private readonly samplesTab: HTMLButtonElement;
	private readonly summaryTable: HTMLElement;
	private readonly sampleTable: HTMLElement;
	private readonly viewTabs: HTMLElement;
	private readonly waveformTab: HTMLButtonElement;
	private readonly histogramTab: HTMLButtonElement;
	private readonly waveformContext: HTMLElement;
	private readonly histogramContext: HTMLElement;
	private readonly waveformElement: HTMLElement;
	private readonly histogramElement: HTMLElement;
	private readonly histogramFitButton: HTMLButtonElement;
	private readonly measurementSelect: HTMLSelectElement;
	private readonly countButton: HTMLButtonElement;
	private readonly percentButton: HTMLButtonElement;
	private readonly specToggle: HTMLInputElement;

	constructor(
		elements: MonteCarloControllerElements,
		private readonly host: AnalysisOverlayHost,
		private readonly histogramChart: MonteCarloHistogramChart,
		private readonly probeNodes: () => ProbeTarget[],
		private readonly activateBottomPanel: (panel: "log" | "mcSummary" | "mcSamples", expand?: boolean) => void,
	) {
		this.app = elements.app;
		this.status = elements.status;
		this.exportButton = elements.exportButton;
		this.summaryTab = elements.summaryTab;
		this.samplesTab = elements.samplesTab;
		this.summaryTable = elements.summaryTable;
		this.sampleTable = elements.sampleTable;
		this.viewTabs = elements.viewTabs;
		this.waveformTab = elements.waveformTab;
		this.histogramTab = elements.histogramTab;
		this.waveformContext = elements.waveformContext;
		this.histogramContext = elements.histogramContext;
		this.waveformElement = elements.waveformElement;
		this.histogramElement = elements.histogramElement;
		this.histogramFitButton = elements.histogramFitButton;
		this.measurementSelect = elements.measurementSelect;
		this.countButton = elements.countButton;
		this.percentButton = elements.percentButton;
		this.specToggle = elements.specToggle;
		this.exportButton.addEventListener("click", () => this.exportCsv());
		this.waveformTab.addEventListener("click", () => this.activateView("waveform"));
		this.histogramTab.addEventListener("click", () => this.activateView("histogram"));
		this.histogramFitButton.addEventListener("click", () => this.histogramChart.fit());
		this.measurementSelect.addEventListener("change", () => this.selectHistogramMeasurement(this.measurementSelect.value, "control"));
		this.countButton.addEventListener("click", () => this.setYAxisMode("count"));
		this.percentButton.addEventListener("click", () => this.setYAxisMode("percent"));
		this.specToggle.addEventListener("change", () => this.histogramChart.setSpecVisible(this.specToggle.checked));
	}

	getResult(): MonteCarloResult | null {
		return this.result;
	}

	selectedProbeLabel(): string {
		return this.probeOptions.find((item) => item.id === this.activeProbeId)?.label || this.activeProbeId || "-";
	}

	present(result: MonteCarloResult): void {
		this.result = result;
		this.measurementConfigs = result.measurementConfigs;
		this.histogramMeasurements = buildHistogramMeasurements(result, this.measurementConfigs);
		this.activeHistogramMeasurementId = this.histogramMeasurements.some((measurement) => measurement.id === this.activeHistogramMeasurementId)
			? this.activeHistogramMeasurementId
			: this.histogramMeasurements[0]?.id || "";
		this.app.classList.add("mc-mode");
		const successCount = result.samples.filter((sample) => sample.ok).length;
		this.status.textContent = t("mc.status", successCount, result.samples.length, result.summaries.length);
		for (const element of [this.status, this.summaryTab, this.samplesTab, this.exportButton, this.viewTabs]) element.classList.remove("hidden");
		this.exportButton.disabled = this.running || result.samples.length === 0;
		this.histogramTab.disabled = this.histogramMeasurements.length === 0;
		this.renderMeasurementOptions();
		this.renderSummary(result.summaries);
		this.renderSamples(result.samples);
		this.activateView("waveform");
		this.renderWaveforms(result);
		this.activateBottomPanel("mcSamples");
		window.setTimeout(() => this.host.resizeCharts(), 30);
	}

	clear(): void {
		this.result = null;
		this.measurementConfigs = [];
		this.probeOptions = [];
		this.activeProbeId = "";
		this.highlightedSampleIndex = null;
		this.histogramMeasurements = [];
		this.activeHistogramMeasurementId = "";
		this.streamStore = null;
		this.streamTemplate = null;
		this.streamTotal = 0;
		this.streamQueued = false;
		this.streamNextRenderAt = 0;
		this.scaffoldDataset = null;
		this.detachAfterRender?.();
		this.detachAfterRender = null;
		this.overlayCanvas?.detach();
		this.overlayCanvas = null;
		this.measurementSelect.innerHTML = "";
		this.histogramChart.setMeasurement(null);
		this.viewTabs.classList.add("hidden");
		this.histogramTab.disabled = true;
		this.activateView("waveform");
		this.app.classList.remove("mc-mode");
		this.status.textContent = t("bottom.notRun");
		for (const element of [this.status, this.summaryTab, this.samplesTab, this.exportButton]) element.classList.add("hidden");
		this.summaryTable.innerHTML = "";
		this.sampleTable.innerHTML = "";
		this.exportButton.disabled = true;
		this.activateBottomPanel("log");
	}

	refreshLocale(): void {
		if (!this.result) {
			this.status.textContent = t("bottom.notRun");
			return;
		}
		const successCount = this.result.samples.filter((sample) => sample.ok).length;
		this.status.textContent = t("mc.status", successCount, this.result.samples.length, this.result.summaries.length);
		this.renderMeasurementOptions();
		this.renderSummary(this.result.summaries);
		this.renderSamples(this.result.samples);
	}

	setRunning(running: boolean): void {
		this.running = running;
		this.exportButton.disabled = running || !this.result;
	}

	traceChoices(): AnalysisTraceChoice[] {
		return this.probeOptions.map((option) => ({
			id: option.id,
			label: option.label,
			traceName: option.traceName,
			description: t("dialog.singleProbeOverlay"),
		}));
	}

	activeTraceChoiceId(): string {
		return this.activeProbeId;
	}

	selectTraceChoice(id: string): void {
		if (!this.result || !this.probeOptions.some((option) => option.id === id)) return;
		this.activeProbeId = id;
		this.highlightedSampleIndex = null;
		this.renderWaveforms(this.result);
		this.activateView("waveform");
		this.host.appendLog(t("log.mcProbeChanged", this.selectedProbeLabel()));
	}

	private activateView(view: AnalysisView): void {
		if (view === "histogram" && !this.histogramMeasurements.length) return;
		const waveform = view === "waveform";
		this.waveformTab.classList.toggle("active", waveform);
		this.histogramTab.classList.toggle("active", !waveform);
		this.waveformTab.setAttribute("aria-selected", String(waveform));
		this.histogramTab.setAttribute("aria-selected", String(!waveform));
		this.waveformContext.classList.toggle("hidden", !waveform);
		this.histogramContext.classList.toggle("hidden", waveform);
		this.waveformElement.classList.toggle("hidden", !waveform);
		this.histogramElement.classList.toggle("hidden", waveform);
		window.setTimeout(() => this.host.resizeCharts(), 30);
	}

	private renderMeasurementOptions(): void {
		this.measurementSelect.innerHTML = this.histogramMeasurements.map((measurement) => (
			`<option value="${escapeHtml(measurement.id)}">${escapeHtml(measurementLabelWithUnit(measurement.label, measurement.unit))}</option>`
		)).join("");
		if (!this.activeHistogramMeasurementId) {
			this.histogramChart.setMeasurement(null);
			return;
		}
		this.selectHistogramMeasurement(this.activeHistogramMeasurementId, "initial");
	}

	private selectHistogramMeasurement(measurementId: string, source: "initial" | "control" | "summary"): void {
		const normalizedId = normalizeMeasurementId(measurementId);
		const measurement = this.histogramMeasurements.find((item) => item.id === normalizedId);
		if (!measurement) return;
		this.activeHistogramMeasurementId = measurement.id;
		this.measurementSelect.value = measurement.id;
		this.specToggle.disabled = !measurement.spec;
		this.histogramChart.setSpecVisible(this.specToggle.checked);
		this.histogramChart.setMeasurement(measurement);
		if (this.result) this.renderSummary(this.result.summaries);
		if (source !== "initial") this.activateBottomPanel("mcSummary", true);
		if (source === "summary") this.activateView("histogram");
	}

	private setYAxisMode(mode: HistogramYAxisMode): void {
		this.countButton.classList.toggle("active", mode === "count");
		this.percentButton.classList.toggle("active", mode === "percent");
		this.histogramChart.setYAxisMode(mode);
	}

	private renderSummary(summaries: MonteCarloSummary[]): void {
		if (!summaries.length) {
			this.summaryTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("table.noSummary"))}</div>`;
			return;
		}
		this.summaryTable.innerHTML = `<table class="mc-table"><thead><tr>
			<th>${escapeHtml(t("table.measurement"))}</th><th>${escapeHtml(t("table.count"))}</th><th>${escapeHtml(t("table.minimum"))}</th><th>${escapeHtml(t("table.maximum"))}</th><th>${escapeHtml(t("table.mean"))}</th><th>${escapeHtml(t("table.stdDev"))}</th><th>P5</th><th>${escapeHtml(t("table.median"))}</th><th>P95</th><th>${escapeHtml(t("table.yield"))}</th>
		</tr></thead><tbody>${summaries.map((summary) => `<tr class="mc-summary-row ${normalizeMeasurementId(summary.measurementId) === this.activeHistogramMeasurementId ? "active" : ""}" data-measurement-id="${escapeHtml(normalizeMeasurementId(summary.measurementId))}">
			<td title="${escapeHtml(summary.measurementId)}">${escapeHtml(measurementLabelWithUnit(summary.label, summary.unit))}</td><td>${formatInteger(summary.count)}</td><td>${formatNumber(summary.min)}</td><td>${formatNumber(summary.max)}</td><td>${formatNumber(summary.mean)}</td><td>${formatNumber(summary.stdDev)}</td><td>${formatNumber(summary.p5)}</td><td>${formatNumber(summary.median)}</td><td>${formatNumber(summary.p95)}</td><td>${summary.yieldRate === undefined ? "-" : `${formatNumber(summary.yieldRate * 100, 3)}%`}</td>
		</tr>`).join("")}</tbody></table>`;
		this.summaryTable.querySelectorAll<HTMLTableRowElement>(".mc-summary-row").forEach((row) => {
			row.addEventListener("click", () => this.selectHistogramMeasurement(row.dataset.measurementId || "", "summary"));
		});
	}

	private renderSamples(samples: MonteCarloSampleResult[]): void {
		if (!samples.length) {
			this.sampleTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("table.noSamples"))}</div>`;
			return;
		}
		const measurementIds = collectSampleMeasurementIds(samples);
		const configsById = new Map(this.measurementConfigs.map((config) => [normalizeMeasurementId(config.id), config]));
		this.sampleTable.innerHTML = `<table class="mc-table"><thead><tr><th>#</th><th>${escapeHtml(t("table.status"))}</th>${measurementIds.map((id) => `<th>${escapeHtml(measurementLabelWithUnit(prettyMeasurementId(id), configsById.get(normalizeMeasurementId(id))?.unit))}</th>`).join("")}<th>${escapeHtml(t("table.error"))}</th></tr></thead>
		<tbody>${samples.map((sample) => {
			const values = new Map(sample.measurements.map((measurement) => [measurement.id, measurement.value]));
			return `<tr class="mc-sample-row ${sample.ok ? "" : "failed"} ${sample.sampleIndex === this.highlightedSampleIndex ? "active" : ""}" data-sample-index="${sample.sampleIndex}"><td>${sample.sampleIndex}</td><td>${sample.ok ? "OK" : escapeHtml(t("table.failed"))}</td>${measurementIds.map((id) => `<td>${values.has(id) ? formatNumber(values.get(id) as number) : "-"}</td>`).join("")}<td title="${escapeHtml(sample.error || "")}">${escapeHtml(sample.error || "")}</td></tr>`;
		}).join("")}</tbody></table>`;
		this.sampleTable.querySelectorAll<HTMLTableRowElement>(".mc-sample-row").forEach((row) => {
			row.addEventListener("click", () => {
				const sampleIndex = Number(row.dataset.sampleIndex);
				if (Number.isFinite(sampleIndex)) this.highlightSample(sampleIndex);
			});
		});
	}

	private renderWaveforms(result: MonteCarloResult): void {
		this.streamStore = null;
		this.streamTemplate = null;
		this.probeOptions = buildMonteCarloProbeOptions(result, this.probeNodes());
		if (!this.probeOptions.length) {
			this.host.appendLog(t("log.noOverlayProbe"));
			return;
		}
		this.activeProbeId = this.probeOptions.some((option) => option.id === this.activeProbeId) ? this.activeProbeId : this.probeOptions[0].id;
		const store = result.waveformStore;
		const template = result.representativeDatasets[0] || null;
		const meta = store ? buildMonteCarloOverlayMetaFromStore(store, template, this.probeOptions, this.activeProbeId) : null;
		if (!store || !meta) {
			this.host.appendLog(t("log.noCurrentProbeWaveform"));
			return;
		}
		this.ensureOverlayCanvas();
		// scaffold：隐形极值线（全部样本的全局 min/max）只用于撑出覆盖全部数据的轴范围，
		// ECharts 不绘制它（name 以 "__" 开头的 trace 会被隐藏）；波形本体全部在画布层。
		const scaffold = this.buildScaffoldDataset(template, meta);
		if (!scaffold) return;
		this.scaffoldDataset = scaffold;
		this.host.setDataset(scaffold, { keepView: true });
		this.overlayCanvas!.clear();
		for (const series of store.getSeries(meta.traceName)) {
			this.overlayCanvas!.addSample({
				sampleIndex: series.sampleIndex,
				time: series.time,
				values: series.values,
				color: sampleColorFor(series.sampleIndex),
			});
		}
		this.overlayCanvas!.setHighlightedSample(null);
		this.highlightedSampleIndex = null;
		this.host.appendLog(t("log.mcOverlayComplete", this.selectedProbeLabel(), store.getSampleCount()));
	}

	/**
	 * scaffold 数据集：隐形极值线。跨全部样本求全局 min/max，各用两个点表达，
	 * name 以 "__" 开头 → 图例/曲线列表隐藏，唯一作用是把轴范围撑到覆盖所有数据。
	 */
	private buildScaffoldDataset(
		template: WaveformDataset | null,
		meta: { traceName: string; axisId: string; unit: string; sampleCount: number },
	): WaveformDataset | null {
		if (!template) return null;
		const store = this.streamStore ?? this.result?.waveformStore;
		if (!store) return null;
		const yAxis = template.yAxes[0];
		const axisId = yAxis?.id || "y1";
		let gMin = Number.POSITIVE_INFINITY;
		let gMax = Number.NEGATIVE_INFINITY;
		for (const series of store.getSeries(meta.traceName)) {
			for (const value of series.values) {
				if (!Number.isFinite(value)) continue;
				if (value < gMin) gMin = value;
				if (value > gMax) gMax = value;
			}
		}
		if (!Number.isFinite(gMin) || !Number.isFinite(gMax)) return null;
		const first = store.getSeries(meta.traceName)[0];
		const t0 = first?.time[0] ?? 0;
		const t1 = first?.time[Math.max(0, first.time.length - 1)] ?? 1;
		// 全透明色：参与 ECharts 轴布局（撑出覆盖全部数据的范围）但不可见。
		const traces: WaveformTrace[] = [
			{ id: "__mc_bound_min__", name: "__min__", axisId, unit: meta.unit, points: [[t0, gMin], [t1, gMin]], color: "rgba(0,0,0,0)" },
			{ id: "__mc_bound_max__", name: "__max__", axisId, unit: meta.unit, points: [[t0, gMax], [t1, gMax]], color: "rgba(0,0,0,0)" },
		];
		return {
			...template,
			id: "mc-scaffold",
			title: "Monte Carlo",
			traces,
			yAxes: template.yAxes,
			meta: {
				...template.meta,
				sourcePlot: `${meta.traceName} · ${meta.sampleCount} samples`,
				// 图表数据自带全量波形（顶部导出用），分区解耦：不跨模块取数。
				waveformStore: store,
				probeTraceName: meta.traceName,
			} as typeof template.meta,
		};
	}

	/** 确保立即模式画布挂在 ECharts 绘图区内，并在每次渲染后对齐几何。 */
	private ensureOverlayCanvas(): void {
		if (this.overlayCanvas) return;
		const container = this.waveformElement;
		if (!container) return;
		container.style.position = "relative";
		const canvas = new McOverlayCanvas();
		canvas.attach(container);
		this.overlayCanvas = canvas;
		// 每次图表渲染（含缩放/平移/resize/显示模式切换）后同步几何与显示模式并整体重绘。
		this.detachAfterRender = this.host.onChartAfterRender?.(() => {
			this.overlayCanvas?.setGeometry(this.host.getPlotGeometry?.() ?? null);
			this.overlayCanvas?.setDisplayMode(this.host.getDisplayMode?.() ?? "line");
		}) ?? null;
		this.overlayCanvas.setGeometry(this.host.getPlotGeometry?.() ?? null);
		this.overlayCanvas.setDisplayMode(this.host.getDisplayMode?.() ?? "line");
	}

	/** MC 运行中的实时渲染入口：由 runner 每样本回调，几何节流 + rAF 合帧。 */
	onSampleProgress(progress: MonteCarloSampleProgress): void {
		this.streamStore = progress.store;
		this.streamTemplate = progress.template;
		this.streamTotal = progress.total;
		const completed = progress.completed;
		if (completed < this.streamTotal && completed < this.streamNextRenderAt) return;
		if (this.streamQueued) return;
		this.streamQueued = true;
		requestAnimationFrame(() => {
			this.streamQueued = false;
			this.renderStreamingOverlay();
		});
	}

	private renderStreamingOverlay(): void {
		const store = this.streamStore;
		if (!store) return;
		if (!this.probeOptions.length) {
			this.probeOptions = buildMonteCarloProbeOptionsFromTemplate(this.streamTemplate, this.probeNodes());
			if (!this.probeOptions.length) return;
		}
		this.activeProbeId = this.probeOptions.some((option) => option.id === this.activeProbeId) ? this.activeProbeId : this.probeOptions[0].id;
		const template = this.streamTemplate;
		const meta = buildMonteCarloOverlayMetaFromStore(store, template, this.probeOptions, this.activeProbeId);
		if (!meta) return;
		this.ensureOverlayCanvas();
		// 首个样本：放一条样本线给 ECharts 建立轴范围，画布才有几何可对齐。
		if (this.overlayCanvas!.getSampleCount() === 0) {
			const first = store.getSeries(meta.traceName)[0];
			if (first) {
				const points: Array<[number, number]> = [];
				const count = Math.min(first.time.length, first.values.length);
				for (let index = 0; index < count; index += 1) points.push([first.time[index], first.values[index]]);
				const streamScaffold = this.buildScaffoldDataset(template, { ...meta, sampleCount: 1 });
				this.scaffoldDataset = streamScaffold;
				this.host.setDataset(streamScaffold);
			}
		}
		// 立即模式：只把“尚未画过”的样本画上去（增量，单条 O(1)）。
		const existing = this.overlayCanvas!.getSampleCount();
		for (const series of store.getSeries(meta.traceName).slice(existing)) {
			this.overlayCanvas!.addSample({
				sampleIndex: series.sampleIndex,
				time: series.time,
				values: series.values,
				color: sampleColorFor(series.sampleIndex),
			});
		}
		this.status.textContent = t("mc.streaming", store.getSampleCount(), this.streamTotal);
	}

	private highlightSample(sampleIndex: number): void {
		this.highlightedSampleIndex = this.highlightedSampleIndex === sampleIndex ? null : sampleIndex;
		// 写入 scaffold meta：图表的跟随读数/交点圆点据此聚焦该样本（mousemove 时实时读取）。
		if (this.scaffoldDataset) this.scaffoldDataset.meta.highlightSampleIndex = this.highlightedSampleIndex ?? undefined;
		this.overlayCanvas?.setHighlightedSample(this.highlightedSampleIndex);
		this.syncSampleHighlight();
		this.activateView("waveform");
	}

	private syncSampleHighlight(): void {
		this.sampleTable.querySelectorAll<HTMLTableRowElement>(".mc-sample-row").forEach((row) => {
			row.classList.toggle("active", Number(row.dataset.sampleIndex) === this.highlightedSampleIndex);
		});
	}

	/** 导出全部 MC 数据：测量 CSV + 全量波形 CSV（供图表头按钮在 MC 模式下转接）。 */
	exportCsv(): void {
		if (!this.result) {
			this.host.appendLog(t("log.noMcExport"));
			return;
		}
		downloadTextFile(
			`monte-carlo-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
			monteCarloResultToCsv(this.result),
			"text/csv;charset=utf-8",
		);
		this.host.appendLog(t("log.mcExported", this.result.samples.length));
	}

}


function sampleColorFor(sampleIndex: number): string {
	const hue = (sampleIndex * 137.508) % 360;
	return `hsl(${hue.toFixed(1)} 72% 46%)`;
}
