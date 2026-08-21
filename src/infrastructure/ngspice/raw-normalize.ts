import { detectSpiceCommandType, findAnalysisCommand, inferAxisId, inferUnit } from "../../shared/netlist";
import type { AnalysisType, SpiceCommandType } from "../../shared/analysis-types";
import type { WaveformAxis, WaveformDataset, WaveformTrace } from "../../shared/waveform";
import type { NgspiceRawEventNode, NgspiceRawPlot, NgspiceRawResult, NgspiceRawVector } from "./raw-result";
import type { ProbeRegistrationTarget } from "./session";

const VECTOR_TIME = 1;
const VECTOR_FREQUENCY = 2;
const VECTOR_VOLTAGE = 3;
const VECTOR_CURRENT = 4;

export interface NormalizeRawResultOptions {
	productAnalysisType?: AnalysisType;
	targets?: ProbeRegistrationTarget[];
}

export function normalizeNgspiceRawResult(
	result: NgspiceRawResult,
	netlist: string,
	options: NormalizeRawResultOptions = {},
): WaveformDataset[] {
	const commandType = detectSpiceCommandType(netlist);
	const plots = selectCurrentPlots(result);
	return plots.flatMap((plot, index) => {
		const dataset = normalizePlot(plot, result.events, netlist, commandType, options, index);
		return dataset ? [dataset] : [];
	});
}

function selectCurrentPlots(result: NgspiceRawResult): NgspiceRawPlot[] {
	const currentPlot = result.currentPlot;
	if (currentPlot) {
		const current = result.plots.find((plot) => sameName(plot.name, currentPlot));
		if (current) return [current];
	}
	return result.plots.length ? [result.plots[0]] : [];
}

function normalizePlot(
	plot: NgspiceRawPlot,
	events: NgspiceRawEventNode[],
	netlist: string,
	commandType: SpiceCommandType,
	options: NormalizeRawResultOptions,
	index: number,
): WaveformDataset | null {
	const scale = findScaleVector(plot.vectors, commandType);
	if (!scale) return null;
	const wanted = targetNames(options.targets ?? []);
	const sourceVectors = plot.vectors.filter((vector) => vector !== scale && isRenderableVector(vector) && matchesTargets(vector, wanted));
	const traces = [
		...sourceVectors.flatMap((vector) => vectorToTraces(vector, scale, commandType)),
		...events.filter((event) => matchesEventTargets(event, options.targets ?? [])).flatMap((event) => eventToTraces(event, scale)),
	];
	if (!traces.length) return null;
	const productAnalysisType = options.productAnalysisType ?? commandType;
	return {
		id: slugify(`${productAnalysisType}-${plot.name}-${index + 1}`),
		productAnalysisType,
		spiceCommandType: commandType,
		title: commandType,
		command: findAnalysisCommand(netlist),
		xAxis: xAxisFor(commandType),
		yAxes: axesFor(traces),
		traces,
		meta: {
			simulationId: `${plot.name}-${Date.now()}`,
			sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
			generatedAt: Date.now(),
			sourcePlot: plot.name,
		},
	};
}

function matchesEventTargets(event: NgspiceRawEventNode, targets: ProbeRegistrationTarget[]): boolean {
	const digitalTargets = targets.filter((target) => target.probeType === 1);
	if (!digitalTargets.length) return false;
	const name = normalizeName(event.name);
	return digitalTargets.some((target) => normalizeName(target.node) === name);
}

/** 数字波形轴 id；与电压/增益/相位分开，独立刻度。 */
const DIGITAL_AXIS_ID = "digital";

function eventToTraces(event: NgspiceRawEventNode, scale: NgspiceRawVector): WaveformTrace[] {
	const samples: Array<[number, number]> = [];
	for (const point of event.points) {
		const value = digitalValue(point.value);
		if (value !== null) samples.push([point.step, value]);
	}
	if (!samples.length) return [];

	// 常量节点（整个仿真只有一个电平）拉成铺满时间范围的平线，
	// 否则单点画不出波形。时间范围取自横轴向量首尾。
	const points = samples.length === 1
		? constantDigitalPoints(samples[0][1], scale.real)
		: stairStepDigitalPoints(samples);
	if (!points.length) return [];

	return [{
		id: slugify(`digital-${event.name}`),
		name: `${normalizeName(event.name)} digital`,
		axisId: DIGITAL_AXIS_ID,
		unit: "LV",
		points,
	}];
}

/**
 * 把采样电平转成台阶式方波：每个电平保持到下一个采样时刻，再垂直跳变到新值
 * （跳变处补一个重复点，避免 ECharts 用斜线连接 0/1）。
 */
function stairStepDigitalPoints(samples: Array<[number, number]>): Array<[number, number]> {
	const points: Array<[number, number]> = [];
	for (let index = 0; index < samples.length; index += 1) {
		const [time, value] = samples[index];
		const next = samples[index + 1];
		points.push([time, value]);
		// 相邻采样点值不同且时间差 > 0 时，在下一个采样时刻补一个同值点，
		// 产生垂直边沿；否则两点间会出现 ECharts 用直线连接的斜线。
		if (next && next[0] > time && next[1] !== value) {
			points.push([next[0], value]);
		}
	}
	return points;
}

/** 常量数字节点铺满横轴范围：首尾各一个同值点。 */
function constantDigitalPoints(value: number, scaleReal: NgspiceRawVector["real"]): Array<[number, number]> {
	const xs = scaleReal.filter((x): x is number => x !== null && Number.isFinite(x));
	if (!xs.length) return [[0, value]];
	const first = xs[0];
	const last = xs[xs.length - 1];
	if (first === last) return [[first, value]];
	return [[first, value], [last, value]];
}

function digitalValue(value: string): number | null {
	const state = value.trim().toLowerCase().charAt(0);
	if (state === "1") return 1;
	if (state === "0") return 0;
	if (state === "u") return 0.5;
	return null;
}

function findScaleVector(vectors: NgspiceRawVector[], type: SpiceCommandType): NgspiceRawVector | null {
	const preferredType = type === "ac" ? VECTOR_FREQUENCY : type === "transient" ? VECTOR_TIME : null;
	if (preferredType !== null) {
		const byType = vectors.find((vector) => vector.vectorType === preferredType);
		if (byType) return byType;
	}
	const names = type === "ac"
		? ["frequency"]
		: type === "transient"
			? ["time"]
			: ["v-sweep", "i-sweep", "temp-sweep", "sweep"];
	return vectors.find((vector) => names.some((name) => sameName(vector.name, name))) ?? null;
}

function isRenderableVector(vector: NgspiceRawVector): boolean {
	return vector.vectorType === VECTOR_VOLTAGE
		|| vector.vectorType === VECTOR_CURRENT
		|| /^v\(/i.test(vector.name)
		|| /^i\(/i.test(vector.name)
		|| /#branch$/i.test(vector.name);
}

function targetNames(targets: ProbeRegistrationTarget[]): Set<string> {
	const names = new Set<string>();
	for (const target of targets) {
		const node = normalizeName(target.node).replace(/^v\((.*)\)$/i, "$1");
		if (!node) continue;
		names.add(node);
		names.add(`v(${node})`);
	}
	return names;
}

function matchesTargets(vector: NgspiceRawVector, wanted: Set<string>): boolean {
	if (!wanted.size) return true;
	const name = normalizeName(vector.name);
	const unwrapped = name.replace(/^v\((.*)\)$/i, "$1");
	return wanted.has(name) || wanted.has(unwrapped);
}

function vectorToTraces(vector: NgspiceRawVector, scale: NgspiceRawVector, type: SpiceCommandType): WaveformTrace[] {
	const displayName = displayVectorName(vector);
	if (type === "ac" && vector.valueType === "complex" && vector.imag) {
		const gain: Array<[number, number]> = [];
		const phase: Array<[number, number]> = [];
		for (let index = 0; index < Math.min(scale.real.length, vector.real.length, vector.imag.length); index += 1) {
			const x = scale.real[index];
			const real = vector.real[index];
			const imag = vector.imag[index];
			if (x === null || real === null || imag === null) continue;
			const magnitude = Math.hypot(real, imag);
			gain.push([x, 20 * Math.log10(Math.max(magnitude, Number.MIN_VALUE))]);
			phase.push([x, Math.atan2(imag, real) * 180 / Math.PI]);
		}
		return [
			{ id: slugify(`gain-${vector.qualifiedName}`), name: `${displayName} gain`, axisId: "gain", unit: "dB", points: gain },
			{ id: slugify(`phase-${vector.qualifiedName}`), name: `${displayName} phase`, axisId: "phase", unit: "deg", points: phase },
		].filter((trace) => trace.points.length);
	}

	const axisId = vector.vectorType === VECTOR_CURRENT ? "current" : inferAxisId(displayName);
	const points: Array<[number, number]> = [];
	for (let index = 0; index < Math.min(scale.real.length, vector.real.length); index += 1) {
		const x = scale.real[index];
		const y = vector.real[index];
		if (x !== null && y !== null) points.push([x, y]);
	}
	if (!points.length) return [];
	return [{
		id: slugify(`${axisId}-${vector.qualifiedName}`),
		name: displayName,
		axisId,
		unit: inferUnit(displayName, axisId),
		points,
	}];
}

function displayVectorName(vector: NgspiceRawVector): string {
	const name = vector.name.trim().toLowerCase();
	if (vector.vectorType === VECTOR_CURRENT || /#branch$/i.test(name) || /^i\(/i.test(name)) return name;
	return /^v\(/i.test(name) ? name : `v(${name})`;
}

function xAxisFor(type: SpiceCommandType): WaveformAxis {
	if (type === "ac") return { id: "frequency", name: "Frequency", unit: "Hz", scale: "log" };
	if (type === "dc") return { id: "sweep", name: "Sweep", unit: "V", scale: "linear" };
	return { id: "time", name: "Time", unit: "s", scale: "linear" };
}

function axesFor(traces: WaveformTrace[]): WaveformAxis[] {
	const axes = new Map<string, WaveformAxis>();
	for (const trace of traces) {
		if (axes.has(trace.axisId)) continue;
		const side = axes.size === 0 ? "left" as const : "right" as const;
		axes.set(trace.axisId, {
			id: trace.axisId,
			name: trace.axisId === "gain" ? "Gain"
				: trace.axisId === "phase" ? "Phase"
					: trace.axisId === "current" ? "Current"
						: trace.axisId === DIGITAL_AXIS_ID ? "Logic"
							: "Voltage",
			unit: trace.unit,
			scale: "linear",
			side,
		});
	}
	return [...axes.values()];
}

function normalizeName(value: string): string {
	return value.trim().toLowerCase();
}

function sameName(a: string, b: string): boolean {
	return normalizeName(a) === normalizeName(b);
}

function slugify(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dataset";
}
