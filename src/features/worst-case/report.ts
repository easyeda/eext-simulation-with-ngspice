import type { WorstCaseResult } from "./types";
import { worstCaseTechnicalRunLabel } from "./case-label";

/** 运行明细行序：标称 → 最坏低侧 → 最坏高侧 → 参数灵敏度（同类保持原相对顺序）。 */
export function sortWorstCaseRuns(runs: WorstCaseResult["runs"]): WorstCaseResult["runs"] {
	const kindOrder: Record<string, number> = { nominal: 0, "worst-low": 1, "worst-high": 2 };
	return [...runs].sort((a, b) => (kindOrder[a.kind] ?? 3) - (kindOrder[b.kind] ?? 3));
}

export function worstCaseResultToCsv(result: WorstCaseResult): string {
	const headers = [
		"recordType", "id", "label", "status", "value", "unit", "delta", "deltaPercent",
		"parameterId", "paramName", "nominalValue", "minValue", "maxValue", "objectiveAtMin",
		"objectiveAtMax", "lowSelection", "highSelection", "impact", "assignments", "error",
	];
	const rows: string[][] = [];
	if (result.summary) {
		rows.push(summaryRow("nominal", result.summary.nominalValue, 0, 0));
		rows.push(summaryRow("worst-low", result.summary.worstLowValue, result.summary.lowDelta, result.summary.lowDeltaPercent));
		rows.push(summaryRow("worst-high", result.summary.worstHighValue, result.summary.highDelta, result.summary.highDeltaPercent));
	}
	for (const impact of result.parameterImpacts) {
		const parameter = result.parameters.find((item) => item.id === impact.parameterId);
		rows.push([
			"parameter-impact", impact.parameterId, impact.label, "", "", parameter?.unit || "", "", "",
			impact.parameterId, parameter?.paramName || "", String(impact.nominalValue), String(impact.minValue), String(impact.maxValue),
			String(impact.objectiveAtMin), String(impact.objectiveAtMax), impact.lowSelection, impact.highSelection, String(impact.impact), "", "",
		]);
	}
	for (const run of sortWorstCaseRuns(result.runs)) {
		const objective = run.measurements.find((item) => item.id === normalizeId(result.objective.measurementId));
		rows.push([
			"case", run.id, worstCaseTechnicalRunLabel(run), run.ok ? "ok" : "failed", objective ? String(objective.value) : "", objective?.unit || result.objective.unit || "", "", "",
			run.parameterId || "", "", "", "", "", "", "", "", "", "", JSON.stringify(run.assignments), run.error || "",
		]);
	}
	return "\uFEFF" + [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");

	function summaryRow(id: string, value: number, delta: number, deltaPercent?: number): string[] {
		return [
			"summary", id, result.objective.label, result.status, String(value), result.objective.unit || "", String(delta),
			deltaPercent === undefined ? "" : String(deltaPercent), "", "", "", "", "", "", "", "", "", "", "", "",
		];
	}
}

function normalizeId(value: string): string {
	return value.trim().toLowerCase();
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
