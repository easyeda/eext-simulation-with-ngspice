import type {
	AnalysisOverlayHost,
	AnalysisTraceChoice,
	AnalysisTraceChoiceController,
} from "../analysis-presentation";
import { escapeHtml, formatNumber, normalizeMeasurementId } from "../format";
import { formatAssignments, formatTolerance, worstCaseRunLabel } from "./format";
import { t } from "../../shared/i18n";
import type { ProbeTarget } from "../../shared/probe";
import { downloadTextFile } from "../download";
import { buildWorstCaseOverlayDataset, buildWorstCaseProbeOptions, type WorstCaseProbeOption } from "../../features/worst-case/view-model";
import { worstCaseResultToCsv } from "../../features/worst-case/report";
import type { WorstCaseObjective, WorstCaseResult } from "../../features/worst-case/types";
import type { VariationParameter } from "../../shared/variation";

export interface WorstCaseControllerElements {
	status: HTMLElement;
	exportButton: HTMLButtonElement;
	summaryTab: HTMLButtonElement;
	impactTab: HTMLButtonElement;
	casesTab: HTMLButtonElement;
	summaryTable: HTMLElement;
	impactTable: HTMLElement;
	casesTable: HTMLElement;
	toleranceTable: HTMLElement;
	app: HTMLElement;
}

export class WorstCaseController implements AnalysisTraceChoiceController {
	private result: WorstCaseResult | null = null;
	private objective: WorstCaseObjective | null = null;
	private probeOptions: WorstCaseProbeOption[] = [];
	private activeProbeId = "";
	private highlightedRunId: string | null = null;
	private running = false;

	private readonly status: HTMLElement;
	private readonly exportButton: HTMLButtonElement;
	private readonly summaryTab: HTMLButtonElement;
	private readonly impactTab: HTMLButtonElement;
	private readonly casesTab: HTMLButtonElement;
	private readonly summaryTable: HTMLElement;
	private readonly impactTable: HTMLElement;
	private readonly casesTable: HTMLElement;
	private readonly toleranceTable: HTMLElement;
	private readonly app: HTMLElement;

	constructor(
		elements: WorstCaseControllerElements,
		private readonly host: AnalysisOverlayHost,
		private readonly probeNodes: () => ProbeTarget[],
		private readonly activateSummaryPanel: () => void,
	) {
		this.status = elements.status;
		this.exportButton = elements.exportButton;
		this.summaryTab = elements.summaryTab;
		this.impactTab = elements.impactTab;
		this.casesTab = elements.casesTab;
		this.summaryTable = elements.summaryTable;
		this.impactTable = elements.impactTable;
		this.casesTable = elements.casesTable;
		this.toleranceTable = elements.toleranceTable;
		this.app = elements.app;
		this.exportButton.addEventListener("click", () => this.exportCsv());
	}

	setObjective(objective: WorstCaseObjective | null): void {
		this.objective = objective;
		this.renderParameters(this.result?.parameters ?? null);
	}

	getResult(): WorstCaseResult | null {
		return this.result;
	}

	present(result: WorstCaseResult): void {
		this.result = result;
		this.objective = result.objective;
		this.app.classList.add("wc-mode");
		for (const element of [this.summaryTab, this.impactTab, this.casesTab, this.status, this.exportButton]) element.classList.remove("hidden");
		this.exportButton.disabled = this.running;
		this.status.textContent = t("wca.status", result.completedRunCount, result.expectedRunCount, result.status);
		this.renderSummary(result);
		this.renderImpact(result);
		this.renderCases(result);
		this.renderParameters(result.parameters);
		this.renderWaveforms(result);
		this.activateSummaryPanel();
	}

	clear(): void {
		this.result = null;
		this.probeOptions = [];
		this.activeProbeId = "";
		this.highlightedRunId = null;
		this.app.classList.remove("wc-mode");
		for (const element of [this.summaryTab, this.impactTab, this.casesTab, this.status, this.exportButton]) element.classList.add("hidden");
		this.exportButton.disabled = true;
		this.summaryTable.innerHTML = "";
		this.impactTable.innerHTML = "";
		this.casesTable.innerHTML = "";
		this.renderParameters(null);
	}

	refreshLocale(): void {
		if (!this.result) {
			this.renderParameters(null);
			return;
		}
		this.status.textContent = t("wca.status", this.result.completedRunCount, this.result.expectedRunCount, this.result.status);
		this.renderSummary(this.result);
		this.renderImpact(this.result);
		this.renderCases(this.result);
		this.renderParameters(this.result.parameters);
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
			description: t("wca.threeCornerOverlay"),
		}));
	}

	activeTraceChoiceId(): string {
		return this.activeProbeId;
	}

	selectTraceChoice(id: string): void {
		if (!this.result || !this.probeOptions.some((option) => option.id === id)) return;
		this.activeProbeId = id;
		this.highlightedRunId = null;
		this.renderWaveforms(this.result);
	}

	private renderSummary(result: WorstCaseResult): void {
		if (!result.summary) {
			this.summaryTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("wca.noSummary"))}</div>`;
			return;
		}
		const rows = [
			{ id: "nominal", label: t("wca.nominal"), value: result.summary.nominalValue, delta: 0, percent: 0 },
			{ id: "worst-low", label: t("wca.worstLow"), value: result.summary.worstLowValue, delta: result.summary.lowDelta, percent: result.summary.lowDeltaPercent },
			{ id: "worst-high", label: t("wca.worstHigh"), value: result.summary.worstHighValue, delta: result.summary.highDelta, percent: result.summary.highDeltaPercent },
		];
		this.summaryTable.innerHTML = `<table class="mc-table wc-table">
			<thead><tr><th>${escapeHtml(t("wca.corner"))}</th><th>${escapeHtml(result.objective.label)}</th><th>${escapeHtml(t("wca.delta"))}</th><th>${escapeHtml(t("wca.deltaPercent"))}</th></tr></thead>
			<tbody>${rows.map((row) => `<tr class="wc-run-row ${this.highlightedRunId === row.id ? "active" : ""}" data-run-id="${row.id}"><td>${escapeHtml(row.label)}</td><td>${formatNumber(row.value)} ${escapeHtml(result.objective.unit || "")}</td><td>${formatNumber(row.delta)}</td><td>${row.percent === undefined ? "--" : `${formatNumber(row.percent)}%`}</td></tr>`).join("")}</tbody>
		</table>`;
		this.installRunHandlers(this.summaryTable);
	}

	private renderImpact(result: WorstCaseResult): void {
		if (!result.parameterImpacts.length) {
			this.impactTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("wca.noImpact"))}</div>`;
			return;
		}
		const sorted = [...result.parameterImpacts].sort((a, b) => b.impact - a.impact);
		const unitSuffix = result.objective.unit ? ` ${escapeHtml(result.objective.unit)}` : "";
		this.impactTable.innerHTML = `<table class="mc-table wc-table">
			<thead><tr><th>${escapeHtml(t("wca.parameter"))}</th><th>${escapeHtml(t("wca.objectiveAtMin"))}</th><th>${escapeHtml(t("wca.objectiveAtMax"))}</th><th>${escapeHtml(t("wca.lowSelection"))}</th><th>${escapeHtml(t("wca.highSelection"))}</th><th>${escapeHtml(t("wca.impact"))}</th></tr></thead>
			<tbody>${sorted.map((item) => `<tr><td>${escapeHtml(item.label)}</td><td>${formatNumber(item.objectiveAtMin)}${unitSuffix}</td><td>${formatNumber(item.objectiveAtMax)}${unitSuffix}</td><td>${escapeHtml(item.lowSelection)}</td><td>${escapeHtml(item.highSelection)}</td><td>${formatNumber(item.impact)}</td></tr>`).join("")}</tbody>
		</table>`;
	}

	private renderCases(result: WorstCaseResult): void {
		this.casesTable.innerHTML = `<table class="mc-table wc-table">
			<thead><tr><th>${escapeHtml(t("wca.case"))}</th><th>${escapeHtml(t("table.status"))}</th><th>${escapeHtml(result.objective.label)}</th><th>${escapeHtml(t("wca.assignments"))}</th><th>${escapeHtml(t("table.error"))}</th></tr></thead>
			<tbody>${result.runs.map((run) => {
				const objective = run.measurements.find((measurement) => measurement.id === normalizeMeasurementId(result.objective.measurementId));
				const finalRun = run.kind === "nominal" || run.kind === "worst-low" || run.kind === "worst-high";
				const objectiveValue = objective ? `${formatNumber(objective.value)}${objective.unit ? ` ${escapeHtml(objective.unit)}` : ""}` : "-";
				return `<tr class="${finalRun ? "wc-run-row" : ""} ${this.highlightedRunId === run.id ? "active" : ""}" ${finalRun ? `data-run-id="${escapeHtml(run.id)}"` : ""}><td>${escapeHtml(worstCaseRunLabel(run.kind, run.parameterId))}</td><td>${run.ok ? "OK" : escapeHtml(t("table.failed"))}</td><td>${objectiveValue}</td><td class="wc-assignments" title="${escapeHtml(JSON.stringify(run.assignments))}">${escapeHtml(formatAssignments(run.assignments))}</td><td>${escapeHtml(run.error || "")}</td></tr>`;
			}).join("")}</tbody>
		</table>`;
		this.installRunHandlers(this.casesTable);
	}

	private renderParameters(parameters: VariationParameter[] | null): void {
		if (!parameters?.length) {
			this.toleranceTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("wca.noParameters"))}</div>`;
			return;
		}
		this.toleranceTable.innerHTML = `<table class="mc-table wc-table">
			<thead><tr><th>${escapeHtml(t("wca.parameter"))}</th><th>${escapeHtml(t("wca.paramName"))}</th><th>${escapeHtml(t("wca.nominal"))}</th><th>${escapeHtml(t("wca.minimum"))}</th><th>${escapeHtml(t("wca.maximum"))}</th><th>${escapeHtml(t("wca.tolerance"))}</th></tr></thead>
			<tbody>${parameters.map((parameter) => `<tr class="${parameter.enabled ? "" : "disabled"}"><td>${escapeHtml(parameter.owner?.refdes || parameter.label)}</td><td>${escapeHtml(parameter.paramName)}</td><td>${formatNumber(parameter.nominalValue)} ${escapeHtml(parameter.unit || "")}</td><td>${formatNumber(parameter.minValue)}</td><td>${formatNumber(parameter.maxValue)}</td><td>${escapeHtml(formatTolerance(parameter.tolerance))}</td></tr>`).join("")}</tbody>
		</table>`;
	}

	private renderWaveforms(result: WorstCaseResult): void {
		this.probeOptions = buildWorstCaseProbeOptions(result, this.probeNodes());
		if (!this.probeOptions.length) {
			this.host.setDataset(null);
			this.host.appendLog(t("wca.noWaveforms"));
			return;
		}
		this.activeProbeId = this.probeOptions.some((option) => option.id === this.activeProbeId) ? this.activeProbeId : this.probeOptions[0].id;
		this.host.setDataset(buildWorstCaseOverlayDataset(result, this.probeOptions, this.activeProbeId));
		this.host.setHighlightedTraceIds(null);
	}

	private installRunHandlers(container: HTMLElement): void {
		container.querySelectorAll<HTMLTableRowElement>(".wc-run-row[data-run-id]").forEach((row) => {
			row.addEventListener("click", () => this.highlightRun(row.dataset.runId || ""));
		});
	}

	private highlightRun(runId: string): void {
		const dataset = this.host.getDataset();
		if (!dataset || !runId) return;
		this.highlightedRunId = this.highlightedRunId === runId ? null : runId;
		const ids = this.highlightedRunId
			? dataset.traces.filter((trace) => trace.meta?.caseId === this.highlightedRunId).map((trace) => trace.id)
			: [];
		this.host.setHighlightedTraceIds(this.highlightedRunId ? ids : null);
		if (this.result) {
			this.renderSummary(this.result);
			this.renderCases(this.result);
		}
	}

	private exportCsv(): void {
		if (!this.result) {
			this.host.appendLog(t("wca.noExport"));
			return;
		}
		downloadTextFile(
			`worst-case-${this.result.spiceCommandType}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`,
			worstCaseResultToCsv(this.result),
			"text/csv;charset=utf-8",
		);
		this.host.appendLog(t("wca.exported"));
	}
}
