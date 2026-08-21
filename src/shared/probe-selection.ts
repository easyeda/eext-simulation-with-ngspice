import type { ProbeTarget } from "./probe";
import { extractCurrentProbes } from "./probe-discovery";
import { probeNameCandidates } from "./probe-names";
import type { WaveformDataset, WaveformTrace } from "./waveform";

export function preferredTraceIdsByDataset(
	datasets: WaveformDataset[],
	probeNodes: ProbeTarget[] = [],
	netlist = "",
): Record<string, string[]> {
	const wanted = new Set<string>();
	for (const probe of probeNodes) {
		for (const candidate of probeNameCandidates(probe.node)) wanted.add(candidate);
	}
	for (const probe of extractCurrentProbes(netlist)) {
		wanted.add(probe.name.toLowerCase());
	}
	if (!wanted.size) return {};

	const result: Record<string, string[]> = {};
	for (const dataset of datasets) {
		const ids = dataset.traces
			.filter((trace) => traceMatchesWanted(trace, wanted))
			.map((trace) => trace.id);
		if (ids.length) result[dataset.id] = ids;
	}
	return result;
}

function traceMatchesWanted(trace: WaveformTrace, wanted: Set<string>): boolean {
	const names = probeNameCandidates(trace.name);
	names.push(...probeNameCandidates(trace.id));
	// AC 分析把每个电压向量拆成 "v(out) gain" / "v(out) phase" 两条 trace,
	// 剥掉 gain/phase 后缀再匹配探针节点,否则按节点筛选会漏掉 AC 波形。
	const baseName = trace.name.replace(/\s+(gain|phase)$/i, "");
	if (baseName !== trace.name) names.push(...probeNameCandidates(baseName));
	return names.some((name) => wanted.has(name));
}
