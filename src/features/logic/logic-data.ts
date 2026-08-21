import type { ProbeTarget } from "../../shared/probe";
import type { SimulationResult, WaveformDataset, WaveformTrace } from "../../shared/waveform";

/** 逻辑值轴 id（逻辑分析图用，不参与波形图）。 */
export const LOGIC_AXIS_ID = "digital";

/** 逻辑状态值：0 / 0.5(U 不确定) / 1。 */
export type LogicValue = 0 | 0.5 | 1;

/** 逻辑分析图的一行：一个逻辑节点的时序数据。 */
export interface LogicRow {
	id: string;
	name: string;
	points: Array<[number, number]>;
	/** 源 trace id（模拟转逻辑时为模拟 trace id）。 */
	sourceTraceId: string;
}

/** 收集逻辑 trace：从 SimulationResult 里抽出 axisId === "digital" 的 trace。 */
export function collectLogicTraces(result: SimulationResult): WaveformTrace[] {
	return result.datasets.flatMap((dataset) => dataset.traces.filter((trace) => trace.axisId === LOGIC_AXIS_ID));
}

/**
 * 模拟 trace → 逻辑行：用探针阈值 lowLevel/highLevel 把电压转成逻辑值。
 * 返回 null 表示探针缺少阈值，无法转换。
 */
export function analogToLogicRow(
	trace: WaveformTrace,
	probe: ProbeTarget,
	highLevel: number,
	lowLevel: number,
): LogicRow {
	const points: Array<[number, number]> = [];
	for (const [x, y] of trace.points) {
		const logic = voltageToLogic(y, lowLevel, highLevel);
		if (logic === null) continue;
		points.push([x, logic]);
	}
	return {
		id: `logic:${trace.id}`,
		name: `${trace.name} (L)`,
		points,
		sourceTraceId: trace.id,
	};
}

/** 电压 → 逻辑值；highLevel 以上为 1，lowLevel 以下为 0，之间为 U(0.5)。 */
function voltageToLogic(value: number, lowLevel: number, highLevel: number): LogicValue | null {
	if (!Number.isFinite(value)) return null;
	if (value >= highLevel) return 1;
	if (value <= lowLevel) return 0;
	return 0.5;
}

/** 逻辑 trace → 模拟 trace：用 highLevel 作为逻辑 1 电压，0 为 0V，U 为中值。 */
export function logicToAnalogTrace(trace: WaveformTrace, highLevel: number): WaveformTrace {
	const points: Array<[number, number]> = trace.points.map(([x, y]) => [x, logicToVoltage(y, highLevel)]);
	return {
		...trace,
		id: `analog:${trace.id}`,
		name: `${trace.name} (A)`,
		axisId: "voltage",
		unit: "V",
		points,
	};
}

function logicToVoltage(value: number, highLevel: number): number {
	if (value === 1) return highLevel;
	if (value === 0) return 0;
	return highLevel / 2;
}

/** 校验探针阈值：逻辑探针转模拟节点需要 lowLevel/highLevel。 */
export function resolveProbeThresholds(probe: ProbeTarget): { lowLevel: number; highLevel: number } | null {
	if (probe.lowLevel === undefined || probe.highLevel === undefined) return null;
	if (!Number.isFinite(probe.lowLevel) || !Number.isFinite(probe.highLevel)) return null;
	return { lowLevel: probe.lowLevel, highLevel: probe.highLevel };
}

/** 把逻辑 trace 从 dataset 中分离（波形图只保留模拟 trace）。 */
export function filterAnalogDataset(dataset: WaveformDataset): WaveformDataset {
	const traces = dataset.traces.filter((trace) => trace.axisId !== LOGIC_AXIS_ID);
	if (traces.length === dataset.traces.length) return dataset;
	return {
		...dataset,
		traces,
		yAxes: dataset.yAxes.filter((axis) => traces.some((trace) => trace.axisId === axis.id)),
		meta: {
			...dataset.meta,
			sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
		},
	};
}

/** 从 SimulationResult 分离出纯模拟结果（过滤数字 trace）。 */
export function filterAnalogResult(result: SimulationResult): SimulationResult {
	const datasets = result.datasets.map(filterAnalogDataset);
	const preferredTraceIdsByDataset: Record<string, string[]> = {};
	for (const [id, ids] of Object.entries(result.preferredTraceIdsByDataset ?? {})) {
		const dataset = datasets.find((item) => item.id === id);
		const analogIds = ids.filter((traceId) => dataset?.traces.some((trace) => trace.id === traceId));
		if (analogIds.length) preferredTraceIdsByDataset[id] = analogIds;
	}
	return {
		...result,
		datasets,
		preferredTraceIdsByDataset,
	};
}
