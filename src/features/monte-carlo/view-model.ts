import type {
	WaveformDataset,
	WaveformTrace,
} from '../../shared/waveform';
import type { ProbeTarget } from '../../shared/probe';
import type { MonteCarloResult } from './types';
import type { McWaveformStore } from './waveform-store';

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
	return buildMonteCarloProbeOptionsFromTemplate(firstMonteCarloSampleDataset(result), probeNodes);
}

export function buildMonteCarloProbeOptionsFromTemplate(
	template: WaveformDataset | null,
	probeNodes: ProbeTarget[],
): MonteCarloProbeOption[] {
	const dataset = template;
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

/**
 * 由波形累积存储构建 MC 叠加的元信息（探针匹配 + 轴过滤）。
 * 曲线本体由立即模式画布直接绘制，不走 WaveformTrace 管线。
 */
export function buildMonteCarloOverlayMetaFromStore(
	store: McWaveformStore,
	template: WaveformDataset | null,
	options: MonteCarloProbeOption[],
	probeId: string,
): { traceName: string; axisId: string; unit: string; sampleCount: number } | null {
	const option = options.find((item) => item.id === probeId) || options[0];
	if (!option || !template) return null;
	const seriesList = store.getSeries(option.traceName);
	if (!seriesList.length) return null;
	return {
		traceName: option.traceName,
		axisId: option.axisId,
		unit: option.unit,
		sampleCount: seriesList.length,
	};
}

function firstMonteCarloSampleDataset(result: MonteCarloResult): WaveformDataset | null {
	return result.representativeDatasets[0] || null;
}


/** 找出探针节点对应的所有 trace(AC 下同节点会有 gain 与 phase 两条)。 */
function findTraceVariantsForProbe(dataset: WaveformDataset, probe: string): WaveformTrace[] {
	const wanted = probeNameCandidates(probe);
	return dataset.traces.filter((trace) => {
		const candidates = [...probeNameCandidates(trace.name), ...probeNameCandidates(trace.id)];
		return candidates.some((candidate) => wanted.has(candidate));
	});
}

/**
 * 由模板数据集生成采集白名单：探针节点对应的 trace 名/id 精确集合。
 * 供 waveform-store 过滤使用，匹配规则与 overlay 完全一致（含 AC gain/phase 后缀）。
 */
export function probeTraceNamesForProbes(dataset: WaveformDataset, probes: ProbeTarget[]): ReadonlySet<string> {
	const names = new Set<string>();
	for (const probe of probes) {
		for (const trace of findTraceVariantsForProbe(dataset, probe.node)) {
			names.add(trace.name);
			names.add(trace.id);
		}
	}
	return names;
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

