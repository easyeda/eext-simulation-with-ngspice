import type {
	AnalysisOverlayHost,
	AnalysisTraceChoice,
	AnalysisTraceChoiceController,
} from "../analysis-presentation";
import { escapeHtml, formatNumber, normalizeMeasurementId } from "../utils/format";
import { mountDataTable } from "../components/data-table";
import { formatAssignments, worstCaseRunLabel } from "./format";
import { t } from "../../shared/i18n";
import type { ProbeTarget } from "../../shared/probe";
import { downloadTextFile } from "../utils/download";
import { buildWorstCaseOverlayDataset, buildWorstCaseProbeOptions, type WorstCaseProbeOption } from "../../features/worst-case/view-model";
import { sortWorstCaseRuns, worstCaseResultToCsv } from "../../features/worst-case/report";
import type { WorstCaseObjective, WorstCaseResult } from "../../features/worst-case/types";

export interface WorstCaseControllerElements {
	status: HTMLElement;
	exportButton: HTMLButtonElement;
	summaryTab: HTMLButtonElement;
	impactTab: HTMLButtonElement;
	casesTab: HTMLButtonElement;
	summaryTable: HTMLElement;
	impactTable: HTMLElement;
	casesTable: HTMLElement;
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
		this.app = elements.app;
		this.exportButton.addEventListener("click", () => this.exportCsv());
	}

	setObjective(objective: WorstCaseObjective | null): void {
		this.objective = objective;
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
	}

	refreshLocale(): void {
		if (!this.result) return;
		this.status.textContent = t("wca.status", this.result.completedRunCount, this.result.expectedRunCount, this.result.status);
		this.renderSummary(this.result);
		this.renderImpact(this.result);
		this.renderCases(this.result);
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
		mountDataTable(this.summaryTable, {
			columns: [t("wca.corner"), result.objective.label, t("wca.delta"), t("wca.deltaPercent")],
			rows: rows.map((row) => ({
				id: row.id,
				className: "wc-run-row",
				active: this.highlightedRunId === row.id,
				cells: [
					row.label,
					`${formatNumber(row.value)}${result.objective.unit ? ` ${result.objective.unit}` : ""}`,
					formatNumber(row.delta),
					row.percent === undefined ? "--" : `${formatNumber(row.percent)}%`,
				],
			})),
			tableClassName: "wc-table",
			onRowActivate: (runId) => this.highlightRun(runId),
		});
	}

	private renderImpact(result: WorstCaseResult): void {
		if (!result.parameterImpacts.length) {
			this.impactTable.innerHTML = `<div class="mc-empty">${escapeHtml(t("wca.noImpact"))}</div>`;
			return;
		}
		const sorted = [...result.parameterImpacts].sort((a, b) => b.impact - a.impact);
		const unitSuffix = result.objective.unit ? ` ${result.objective.unit}` : "";
		const objectiveName = result.objective.label.replace(/\s+at\s+.*$/i, "").trim();
		const objectiveSuffix = objectiveName ? ` (${objectiveName})` : "";
		const formatSelection = (selection: "min" | "max" | "nominal", item: { minValue: number; maxValue: number; nominalValue: number }): string => {
			if (selection === "min") return `MIN=${formatNumber(item.minValue)}`;
			if (selection === "max") return `MAX=${formatNumber(item.maxValue)}`;
			return `NOMINAL=${formatNumber(item.nominalValue)}`;
		};
		mountDataTable(this.impactTable, {
			columns: [
				t("wca.parameter"),
				`${t("wca.objectiveAtMin")}${objectiveSuffix}`,
				`${t("wca.objectiveAtMax")}${objectiveSuffix}`,
				t("wca.lowSelection"),
				t("wca.highSelection"),
				t("wca.impact"),
			],
			rows: sorted.map((item) => ({
				cells: [
					item.label,
					`${formatNumber(item.objectiveAtMin)}${unitSuffix}`,
					`${formatNumber(item.objectiveAtMax)}${unitSuffix}`,
					formatSelection(item.lowSelection, item),
					formatSelection(item.highSelection, item),
					formatNumber(item.impact),
				],
			})),
			tableClassName: "wc-table",
		});
	}

	private renderCases(result: WorstCaseResult): void {
		const sortedRuns = sortWorstCaseRuns(result.runs);
		mountDataTable(this.casesTable, {
			columns: [t("wca.case"), t("table.status"), result.objective.label, t("wca.assignments"), t("table.error")],
			rows: sortedRuns.map((run) => {
				const objective = run.measurements.find((measurement) => measurement.id === normalizeMeasurementId(result.objective.measurementId));
				const finalRun = run.kind === "nominal" || run.kind === "worst-low" || run.kind === "worst-high";
				const objectiveValue = objective ? `${formatNumber(objective.value)}${objective.unit ? ` ${objective.unit}` : ""}` : "-";
				return {
					...(finalRun ? { id: run.id, className: "wc-run-row", active: this.highlightedRunId === run.id } : {}),
					cells: [
						worstCaseRunLabel(run.kind, run.parameterId),
						run.ok ? "OK" : t("table.failed"),
						objectiveValue,
						{ text: formatAssignments(run.assignments), className: "wc-assignments", title: JSON.stringify(run.assignments) },
						run.error || "",
					],
				};
			}),
			tableClassName: "wc-table",
			onRowActivate: (runId) => this.highlightRun(runId),
		});
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
