import { inferUnit } from "./netlist";
import { extractCurrentProbes } from "./probe-discovery";
import { probeNameCandidates, sameProbeName } from "./probe-names";
import type { WaveformDataset, WaveformTrace } from "./waveform";

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
			if (nextTraces.some((trace) => sameProbeName(trace.name, probe.name))) continue;
			const a = findVoltageTrace(dataset.traces, probe.nodeA);
			const b = findVoltageTrace(dataset.traces, probe.nodeB);
			if (!a || !b) continue;
			const points = subtractAlignedPoints(a.points, b.points, probe.resistance);
			if (!points.length) continue;
			nextTraces.push({
				id: slugify(`current:${probe.name}`),
				name: probe.name,
				axisId: "current",
				unit: inferUnit(probe.name, "current"),
				points,
			});
			changed = true;
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

function findVoltageTrace(traces: WaveformTrace[], node: string): WaveformTrace | null {
	const candidates = new Set(probeNameCandidates(node));
	return traces.find((trace) => (
		trace.axisId === "voltage" && traceMatchesWanted(trace, candidates)
	)) ?? null;
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
		points.push([ax, (a[index][1] - b[index][1]) / divisor]);
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
