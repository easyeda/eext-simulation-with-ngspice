import { inferUnit } from "./netlist";
import { extractCurrentProbes } from "./probe-discovery";
import { probeNameCandidates, sameProbeName } from "./probe-names";
import type { WaveformDataset, WaveformTrace } from "./waveform";

/** 双源 DC 分组：电压 trace 按 meta.groupIndex 拆分；null = 无分组（普通分析/单源）。 */
interface TraceGroup {
	index: number | null;
	label: string | null;
}

export function addSyntheticCurrentProbeTraces(
	datasets: WaveformDataset[],
	netlist: string,
): WaveformDataset[] {
	const currentProbes = extractCurrentProbes(netlist);
	if (!currentProbes.length) return datasets;

	return datasets.map((dataset) => {
		if (dataset.spiceCommandType === "ac") return dataset;
		const nextTraces = [...dataset.traces];
		let changed = false;
		for (const probe of currentProbes) {
			// 双源 DC 的电压曲线带分组（meta.groupIndex）：逐组配对合成电流，
			// 无分组时 index 为 null 走原有路径。
			for (const group of collectTraceGroups(dataset.traces)) {
				if (nextTraces.some((trace) => (
					sameProbeName(trace.name, probe.name) && (trace.meta?.groupIndex ?? null) === group.index
				))) continue;
				const a = findVoltageTraceForGroup(dataset.traces, probe.nodeA, group.index);
				const b = findVoltageTraceForGroup(dataset.traces, probe.nodeB, group.index);
				if (!a || !b) continue;
				const points = subtractAlignedPoints(a.points, b.points, probe.resistance);
				if (!points.length) continue;
				nextTraces.push({
					id: slugify(`current:${probe.name}${group.index !== null ? `-g${group.index + 1}` : ""}`),
					name: probe.name,
					axisId: "current",
					unit: inferUnit(probe.name, "current"),
					points,
					...(group.index !== null || group.label
						? {
							meta: {
								...(group.index !== null ? { groupIndex: group.index } : {}),
								...(group.label ? { groupLabel: group.label } : {}),
							},
						}
						: {}),
				});
				changed = true;
			}
		}
		if (!changed) return dataset;
		const hasCurrentAxis = dataset.yAxes.some((axis) => axis.id === "current");
		return {
			...dataset,
			yAxes: hasCurrentAxis
				? dataset.yAxes
				: [
					...dataset.yAxes,
					{
						id: "current",
						name: "Current",
						unit: "A",
						scale: "linear" as const,
						side: dataset.yAxes.length ? "right" as const : "left" as const,
					},
				],
			traces: nextTraces,
			meta: {
				...dataset.meta,
				sampleCount: nextTraces.reduce((sum, trace) => sum + trace.points.length, 0),
			},
		};
	});
}

/** 数据集中出现的分组集合（电压 trace 的 meta.groupIndex/groupLabel），保持出现顺序。 */
function collectTraceGroups(traces: WaveformTrace[]): TraceGroup[] {
	const groups: TraceGroup[] = [];
	for (const trace of traces) {
		if (trace.axisId !== "voltage") continue;
		const index = trace.meta?.groupIndex ?? null;
		if (groups.some((group) => group.index === index)) continue;
		groups.push({ index, label: trace.meta?.groupLabel ?? null });
	}
	return groups;
}

function findVoltageTraceForGroup(
	traces: WaveformTrace[],
	node: string,
	groupIndex: number | null,
): WaveformTrace | null {
	const candidates = new Set(probeNameCandidates(node));
	return traces.find((trace) => {
		if (trace.axisId !== "voltage") return false;
		if ((trace.meta?.groupIndex ?? null) !== groupIndex) return false;
		return traceMatchesWanted(trace, candidates);
	}) ?? null;
}

function subtractAlignedPoints(
	a: Array<[number, number]>,
	b: Array<[number, number]>,
	divisor: number,
): Array<[number, number]> {
	const length = Math.min(a.length, b.length);
	const points: Array<[number, number]> = [];
	for (let index = 0; index < length; index += 1) {
		const ax = a[index][0];
		const bx = b[index][0];
		if (
			!Number.isFinite(ax)
			|| !Number.isFinite(bx)
			|| Math.abs(ax - bx) > Math.max(1e-15, Math.abs(ax) * 1e-9)
		) continue;
		const av = a[index][1];
		const bv = b[index][1];
		if (!Number.isFinite(av) || !Number.isFinite(bv)) continue;
		points.push([ax, (av - bv) / divisor]);
	}
	return points;
}

function traceMatchesWanted(trace: WaveformTrace, wanted: Set<string>): boolean {
	const names = probeNameCandidates(trace.name);
	names.push(...probeNameCandidates(trace.id));
	return names.some((name) => wanted.has(name));
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trace";
}
