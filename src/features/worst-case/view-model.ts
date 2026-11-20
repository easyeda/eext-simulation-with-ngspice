import type { ProbeTarget } from "../../shared/probe";
import type { WaveformDataset, WaveformTrace } from "../../shared/waveform";
import { probeNameCandidates } from "../../shared/probe-names";
import { dialogTraceLabel, probeNameByNode } from "../../shared/probe-display";
import { unwrapPhaseTrace } from "../../shared/phase-unwrap";
import type { WorstCaseResult, WorstCaseRunResult } from "./types";
import { worstCaseTechnicalRunLabel } from "./case-label";

export interface WorstCaseProbeOption {
	id: string;
	label: string;
	traceId: string;
	traceName: string;
	axisId: string;
	unit: string;
}

export function buildWorstCaseProbeOptions(
	result: WorstCaseResult,
	probeNodes: ProbeTarget[],
): WorstCaseProbeOption[] {
	const dataset = result.finalDatasets[0];
	if (!dataset) return [];
	const probeNames = probeNameByNode(probeNodes);
	const options: WorstCaseProbeOption[] = [];
	const used = new Set<string>();
	for (const probe of probeNodes) {
		// AC 下同节点拆 gain/phase 两条，都作为独立选项（与 MC 一致）。
		for (const trace of findTraceVariantsForProbe(dataset, probe.node)) {
			if (used.has(trace.id)) continue;
			used.add(trace.id);
			options.push(toOption(trace, dialogTraceLabel(trace.name, probeNames)));
		}
	}
	// XAM 电流探针曲线合成
	for (const trace of dataset.traces) {
		if (trace.axisId !== "current" || used.has(trace.id)) continue;
		used.add(trace.id);
		options.push(toOption(trace, dialogTraceLabel(trace.name, probeNames)));
	}
	if (options.length) return options;
	return dataset.traces.slice(0, 1).map((trace) => toOption(trace, dialogTraceLabel(trace.name, probeNames)));
}

export function buildWorstCaseOverlayDataset(
	result: WorstCaseResult,
	options: WorstCaseProbeOption[],
	probeId: string,
	/** 可选。相位解卷绕开启时，相位曲线拷贝为连续相位副本（仅显示层）。 */
	unwrapPhase = false,
): WaveformDataset | null {
	const option = options.find((item) => item.id === probeId) || options[0];
	const firstDataset = result.finalDatasets[0];
	if (!option || !firstDataset) return null;
	const traces: WaveformTrace[] = [];
	for (const run of finalRuns(result.runs)) {
		const sourceDataset = run.datasets?.[0];
		if (!sourceDataset) continue;
		const sourceTrace = sourceDataset.traces.find((trace) => trace.id === option.traceId)
			|| findTraceForProbe(sourceDataset, option.label)
			|| sourceDataset.traces.find((trace) => normalizeTraceText(trace.name) === normalizeTraceText(option.traceName));
		if (!sourceTrace) continue;
		const displayTrace = unwrapPhase ? unwrapPhaseTrace(sourceTrace) : sourceTrace;
		traces.push({
			...displayTrace,
			id: `wc-${run.id}-${option.id}`,
			name: worstCaseTechnicalRunLabel(run),
			color: runColor(run),
			meta: {
				caseId: run.id,
				caseKind: run.kind,
				probeKey: option.id,
				sourceTraceId: sourceTrace.id,
				sourceTraceName: sourceTrace.name,
			},
		});
	}
	if (!traces.length) return null;
	return {
		...firstDataset,
		id: `wc-overlay-${option.id}`,
		productAnalysisType: "worst-case",
		title: `Worst Case - ${option.label}`,
		traces,
		yAxes: firstDataset.yAxes.filter((axis) => traces.some((trace) => trace.axisId === axis.id)),
		meta: {
			...firstDataset.meta,
			sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
			sourcePlot: `one-at-a-time-corner · ${option.label}`,
		},
	};
}

function finalRuns(runs: WorstCaseRunResult[]): WorstCaseRunResult[] {
	return runs.filter((run) => run.kind === "nominal" || run.kind === "worst-low" || run.kind === "worst-high");
}

function toOption(trace: WaveformTrace, label: string): WorstCaseProbeOption {
	return {
		id: normalizeProbeOptionId(label || trace.id),
		label: label || trace.name,
		traceId: trace.id,
		traceName: trace.name,
		axisId: trace.axisId,
		unit: trace.unit,
	};
}

function findTraceForProbe(dataset: WaveformDataset, probe: string): WaveformTrace | null {
	const wanted = new Set(probeNameCandidates(probe));
	return dataset.traces.find((trace) => {
		const candidates = [...probeNameCandidates(trace.name), ...probeNameCandidates(trace.id)];
		return candidates.some((candidate) => wanted.has(candidate));
	}) || null;
}

/** 找出探针节点对应的所有 trace（AC 下同节点会有 gain 与 phase 两条）。 */
function findTraceVariantsForProbe(dataset: WaveformDataset, probe: string): WaveformTrace[] {
	const wanted = new Set(probeNameCandidates(probe));
	return dataset.traces.filter((trace) => {
		const candidates = [...probeNameCandidates(trace.name), ...probeNameCandidates(trace.id)];
		return candidates.some((candidate) => wanted.has(candidate));
	});
}

function normalizeTraceText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, "");
}

function normalizeProbeOptionId(value: string): string {
	return normalizeTraceText(value).replace(/[^a-z0-9]+/g, "-") || "probe";
}

function runColor(run: WorstCaseRunResult): string 
{
	if (run.kind === "worst-low") return "#2563eb";
	if (run.kind === "worst-high") return "#dc2626";
	return "#111827";
}
