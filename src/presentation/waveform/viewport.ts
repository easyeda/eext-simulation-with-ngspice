import type { WaveformDataset, WaveformTrace } from "../../shared/waveform";
import { clamp } from "./axis-format";
import { extent } from "./series-data";

export interface ViewState {
	xMin: number;
	xMax: number;
	y: Map<string, { min: number; max: number }>;
}

export interface XBounds {
	min: number;
	max: number;
	isLog: boolean;
}

export function computeView(
	dataset: WaveformDataset,
	traces: WaveformTrace[] = dataset.traces,
): ViewState {
	const allPoints = traces.flatMap((trace) => trace.points);
	const xs = allPoints
		.map((point) => point[0])
		.filter((value) => Number.isFinite(value) && (dataset.xAxis.scale !== "log" || value > 0));
	const xRange = paddedRange(xs, dataset.xAxis.scale === "log");
	const y = new Map<string, { min: number; max: number }>();
	const axes = dataset.yAxes.length
		? dataset.yAxes
		: [{ id: "voltage", name: "Voltage", unit: "V", scale: "linear" as const }];
	for (const axis of axes) {
		const values = traces
			.filter((trace) => trace.axisId === axis.id)
			.flatMap((trace) => trace.points.map((point) => point[1]))
			.filter(Number.isFinite);
		y.set(axis.id, paddedRange(values, axis.scale === "log"));
	}
	return { xMin: xRange.min, xMax: xRange.max, y };
}

export function fitXToDataBounds(
	dataset: WaveformDataset,
	traces: WaveformTrace[],
): Pick<ViewState, "xMin" | "xMax"> {
	const xs = traces
		.flatMap((trace) => trace.points.map((point) => point[0]))
		.filter((value) => Number.isFinite(value) && (dataset.xAxis.scale !== "log" || value > 0));
	if (!xs.length) return { xMin: 0, xMax: 1 };

	const [min, max] = extent(xs);
	if (min === max) {
		if (dataset.xAxis.scale === "log") {
			return { xMin: Math.max(Number.MIN_VALUE, min / 10), xMax: max * 10 };
		}
		const pad = Math.abs(min || 1) * 0.1;
		return { xMin: min - pad, xMax: max + pad };
	}
	return { xMin: min, xMax: max };
}

export function initialCursorValue(min: number, max: number, isLog: boolean): number {
	if (isLog) return Math.max(min, Number.MIN_VALUE);
	return Math.min(max, Math.max(min, 0));
}

export function zoomRange(
	min: number,
	max: number,
	focus: number,
	scale: number,
	isLog: boolean,
): { min: number; max: number } {
	if (!Number.isFinite(focus)) focus = (min + max) / 2;
	if (isLog) {
		const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
		const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
		const logFocus = Math.log10(Math.max(focus, Number.MIN_VALUE));
		return {
			min: 10 ** (logFocus - (logFocus - logMin) * scale),
			max: 10 ** (logFocus + (logMax - logFocus) * scale),
		};
	}
	return {
		min: focus - (focus - min) * scale,
		max: focus + (max - focus) * scale,
	};
}

export function panRange(
	min: number,
	max: number,
	ratio: number,
	isLog: boolean,
	direction: "x" | "y",
): { min: number; max: number } {
	const signedRatio = direction === "x" ? -ratio : ratio;
	if (isLog) {
		const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
		const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
		const shift = signedRatio * (logMax - logMin);
		return {
			min: 10 ** (logMin + shift),
			max: 10 ** (logMax + shift),
		};
	}
	const shift = signedRatio * (max - min);
	return {
		min: min + shift,
		max: max + shift,
	};
}

export function constrainXView(
	range: { min: number; max: number },
	bounds: XBounds,
): { min: number; max: number } {
	const dataMin = Math.min(bounds.min, bounds.max);
	const dataMax = Math.max(bounds.min, bounds.max);
	if (!Number.isFinite(dataMin) || !Number.isFinite(dataMax) || dataMin === dataMax) return range;

	let min = Math.min(range.min, range.max);
	let max = Math.max(range.min, range.max);
	if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: dataMin, max: dataMax };

	if (bounds.isLog) {
		min = Math.max(min, Number.MIN_VALUE);
		max = Math.max(max, min * 1.0000001);
	}

	const dataSpan = dataMax - dataMin;
	let span = max - min;
	if (span >= dataSpan) return { min: dataMin, max: dataMax };

	if (min < dataMin) {
		max += dataMin - min;
		min = dataMin;
	}
	if (max > dataMax) {
		min -= max - dataMax;
		max = dataMax;
	}

	if (min < dataMin) min = dataMin;
	if (max > dataMax) max = dataMax;
	if (max <= min) {
		const center = clamp((min + max) / 2, dataMin, dataMax);
		span = Math.min(dataSpan, Math.max(dataSpan * 1e-9, Number.EPSILON));
		min = clamp(center - span / 2, dataMin, dataMax);
		max = clamp(center + span / 2, dataMin, dataMax);
	}
	return { min, max };
}

export function cloneView(view: ViewState): ViewState {
	return {
		xMin: view.xMin,
		xMax: view.xMax,
		y: new Map([...view.y.entries()].map(([key, value]) => [key, { ...value }])),
	};
}

function paddedRange(values: number[], isLog: boolean): { min: number; max: number } {
	const usable = values.filter((value) => Number.isFinite(value) && (!isLog || value > 0));
	if (!usable.length) return isLog ? { min: 1, max: 10 } : { min: 0, max: 1 };
	const [min, max] = extent(usable);
	if (min === max) {
		const pad = Math.abs(min || 1) * 0.1;
		return isLog
			? { min: Math.max(Number.MIN_VALUE, min / 10), max: max * 10 }
			: { min: min - pad, max: max + pad };
	}
	if (isLog) {
		const logMin = Math.log10(min);
		const logMax = Math.log10(max);
		const pad = Math.max((logMax - logMin) * 0.04, 0.04);
		return { min: 10 ** (logMin - pad), max: 10 ** (logMax + pad) };
	}
	const pad = Math.max((max - min) * 0.08, Number.EPSILON);
	return { min: min - pad, max: max + pad };
}
