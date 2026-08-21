import type {
	WaveformDataset,
	WaveformTrace,
} from '../../shared/waveform';
import type { ProbeTarget } from '../../shared/probe';
import type { MonteCarloResult, MonteCarloSampleResult } from './types';

export interface MonteCarloProbeOption {
	id: string;
	label: string;
	traceId: string;
	traceName: string;
	axisId: string;
	unit: string;
}

export function buildMonteCarloProbeOptions(
	result: MonteCarloResult,
	probeNodes: ProbeTarget[],
): MonteCarloProbeOption[] {
	const dataset = firstMonteCarloSampleDataset(result);
	if (!dataset) return [];
	const options: MonteCarloProbeOption[] = [];
	const used = new Set<string>();

	for (const probe of probeNodes) {
		// AC 分析下同一节点会拆成 "v(x) gain" 和 "v(x) phase" 两条 trace,
		// 都作为独立选项,便于分别叠加增益与相位。
		for (const trace of findTraceVariantsForProbe(dataset, probe.node)) {
			if (used.has(trace.id)) continue;
			used.add(trace.id);
			options.push({
				id: normalizeProbeOptionId(trace.id),
				label: trace.name,
				traceId: trace.id,
				traceName: trace.name,
				axisId: trace.axisId,
				unit: trace.unit,
			});
		}
	}

	if (options.length) return options;
	return dataset.traces.slice(0, 1).map((trace) => ({
		id: normalizeProbeOptionId(trace.id),
		label: trace.name,
		traceId: trace.id,
		traceName: trace.name,
		axisId: trace.axisId,
		unit: trace.unit,
	}));
}

export function buildMonteCarloOverlayDataset(
	result: MonteCarloResult,
	options: MonteCarloProbeOption[],
	probeId: string,
): WaveformDataset | null {
	const option = options.find((item) => item.id === probeId) || options[0];
	if (!option) return null;
	const firstDataset = firstMonteCarloSampleDataset(result);
	if (!firstDataset) return null;
	const traces: WaveformTrace[] = [];

	for (const sample of result.samples) {
		if (!sample.ok || !sample.datasets?.length) continue;
		const sampleDataset = sample.datasets[0];
		const sourceTrace = sampleDataset.traces.find((trace) => trace.id === option.traceId)
			|| findTraceForProbe(sampleDataset, option.label)
			|| sampleDataset.traces.find((trace) => normalizeTraceText(trace.name) === normalizeTraceText(option.traceName));
		if (!sourceTrace) continue;
		traces.push({
			...sourceTrace,
			id: `mc-${option.id}-${sample.sampleIndex}`,
			name: `#${sample.sampleIndex}`,
			color: sampleColor(sample.sampleIndex),
			meta: {
				sampleIndex: sample.sampleIndex,
				probeKey: option.id,
				sourceTraceId: sourceTrace.id,
				sourceTraceName: sourceTrace.name,
			},
		});
	}

	if (!traces.length) return null;
	return {
		...firstDataset,
		id: `mc-overlay-${option.id}`,
		title: 'Monte Carlo',
		traces,
		yAxes: firstDataset.yAxes.filter((axis) => traces.some((trace) => trace.axisId === axis.id)),
		meta: {
			...firstDataset.meta,
			sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
			sourcePlot: `${option.label} · ${traces.length}/${result.samples.length} samples`,
		},
	};
}

function firstMonteCarloSampleDataset(result: MonteCarloResult): WaveformDataset | null {
	for (const sample of result.samples) {
		if (sample.ok && sample.datasets?.length) return sample.datasets[0];
	}
	return result.representativeDatasets[0] || null;
}

function findTraceForProbe(dataset: WaveformDataset, probe: string): WaveformTrace | null {
	return findTraceVariantsForProbe(dataset, probe)[0] || null;
}

/** 找出探针节点对应的所有 trace(AC 下同节点会有 gain 与 phase 两条)。 */
function findTraceVariantsForProbe(dataset: WaveformDataset, probe: string): WaveformTrace[] {
	const wanted = probeNameCandidates(probe);
	return dataset.traces.filter((trace) => {
		const candidates = [...probeNameCandidates(trace.name), ...probeNameCandidates(trace.id)];
		return candidates.some((candidate) => wanted.has(candidate));
	});
}

function probeNameCandidates(value: string): Set<string> {
	const text = normalizeTraceText(value);
	// AC 分析的 trace 名带 "gain"/"phase" 后缀,数字探针 trace 名带 "digital" 后缀,
	// 剥离后再生成候选,否则按节点筛选会漏掉 AC 波形与数字波形。
	const stripped = text.replace(/(gain|phase)$/i, "").replace(/digital$/i, "");
	const result = new Set<string>();
	for (const item of new Set([text, stripped].filter(Boolean))) {
		const unwrapped = item.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
		for (const candidate of [item, unwrapped, `v(${unwrapped})`, `i(${unwrapped})`]) {
			result.add(normalizeTraceText(candidate));
		}
	}
	return result;
}

function normalizeTraceText(value: string): string {
	return value.trim().toLowerCase().replace(/\s+/g, '');
}

function normalizeProbeOptionId(value: string): string {
	return normalizeTraceText(value).replace(/[^a-z0-9]+/g, '-') || 'probe';
}

function sampleColor(sampleIndex: number): string {
	const hue = (sampleIndex * 137.508) % 360;
	return `hsl(${hue.toFixed(1)} 72% 46%)`;
}
