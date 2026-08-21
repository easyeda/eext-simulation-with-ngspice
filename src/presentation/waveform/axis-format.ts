import { getNumberLocale } from "../../shared/i18n";

export type AxisScale = "linear" | "log";

export function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString(getNumberLocale()) : "0";
}

export function labelForAnalysis(type: string): string {
	if (type === "ac") return "AC";
	if (type === "dc") return "DC Sweep";
	return "Transient";
}

export function axisDisplayUnit(
	unit: string,
	min?: number,
	max?: number,
	value = 0,
): { label: string; factor: number } {
	const unitGroup = unitScaleGroup(unit);
	const selected = unitGroup
		? selectAxisUnit(unitGroup, min, max, value)
		: [unit, 1] as [string, number];
	return { label: selected[0], factor: selected[1] };
}

export function formatInspectionValue(
	value: number,
	unit: string,
	min?: number,
	max?: number,
): string {
	if (!Number.isFinite(value)) return "";
	const displayUnit = axisDisplayUnit(unit, min, max, value);
	const formatted = formatWaveformValue(value / displayUnit.factor);
	return displayUnit.label ? `${formatted} ${displayUnit.label}` : formatted;
}

export function makeAxisLabelFormatter(
	unit: string,
	scale: AxisScale,
	min?: number,
	max?: number,
): (value: number) => string {
	return (value: number) => formatAxisTickValue(value, unit, scale, min, max);
}

export function axisMinInterval(
	unit: string,
	scale: AxisScale,
	min?: number,
	max?: number,
): number | undefined {
	if (scale === "log") return undefined;
	const span = visibleSpan(min, max);
	const unitGroup = unitScaleGroup(unit);
	const selected = unitGroup ? selectAxisUnit(unitGroup, min, max) : null;
	const factor = selected?.[1] ?? 1;
	const reference = Math.max(
		Math.abs(Number(min) || 0),
		Math.abs(Number(max) || 0),
		Number.isFinite(span) ? span : 0,
	);
	const scaledReference = reference / factor;
	const resolution = significantResolution(scaledReference || span / factor || 1);
	return resolution * factor;
}

export function readableAxisRange(
	range: { min: number; max: number } | undefined,
	unit: string,
	scale: AxisScale,
): { min: number; max: number } {
	if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) {
		return scale === "log" ? { min: 1, max: 10 } : { min: 0, max: 1 };
	}
	if (scale === "log") return range;
	const min = Math.min(range.min, range.max);
	const max = Math.max(range.min, range.max);
	const span = Math.max(max - min, 0);
	const minInterval = axisMinInterval(unit, scale, min, max) ?? 0;
	if (!Number.isFinite(minInterval) || minInterval <= 0) return { min, max };

	const minimumSpan = minInterval * 2;
	let nextMin = min;
	let nextMax = max;
	if (span < minimumSpan) {
		const center = (min + max) / 2;
		nextMin = center - minimumSpan / 2;
		nextMax = center + minimumSpan / 2;
	}

	nextMin = Math.floor(nextMin / minInterval) * minInterval;
	nextMax = Math.ceil(nextMax / minInterval) * minInterval;
	if (nextMax - nextMin < minimumSpan) {
		nextMin -= minInterval;
		nextMax += minInterval;
	}

	return {
		min: normalizeAxisBoundary(nextMin),
		max: normalizeAxisBoundary(nextMax),
	};
}

export function constrainAxisView(
	range: { min: number; max: number },
	unit: string,
	scale: AxisScale,
): { min: number; max: number } {
	if (scale === "log") return range;
	const min = Math.min(range.min, range.max);
	const max = Math.max(range.min, range.max);
	const minInterval = axisMinInterval(unit, scale, min, max) ?? 0;
	const minimumSpan = minInterval * 2;
	if (!Number.isFinite(minimumSpan) || minimumSpan <= 0 || max - min >= minimumSpan) {
		return { min, max };
	}
	const center = (min + max) / 2;
	return {
		min: normalizeAxisBoundary(center - minimumSpan / 2),
		max: normalizeAxisBoundary(center + minimumSpan / 2),
	};
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;",
	}[char] || char));
}

function formatAxisValue(value: number, unit: string): string {
	if (!Number.isFinite(value)) return "";
	const abs = Math.abs(value);
	if (unit === "Hz") return scaleUnit(value, [["GHz", 1e9], ["MHz", 1e6], ["kHz", 1e3], ["Hz", 1]]);
	if (unit === "s") return scaleUnit(value, [["s", 1], ["ms", 1e-3], ["us", 1e-6], ["ns", 1e-9], ["ps", 1e-12]]);
	if (unit === "V") return scaleUnit(value, [["kV", 1e3], ["V", 1], ["mV", 1e-3], ["uV", 1e-6]]);
	if (unit === "A") return scaleUnit(value, [["A", 1], ["mA", 1e-3], ["uA", 1e-6], ["nA", 1e-9]]);
	const formatted = formatWaveformValue(value);
	return unit ? `${formatted} ${unit}` : formatted;
}

function scaleUnit(value: number, units: Array<[string, number]>): string {
	const abs = Math.abs(value);
	const selected = units.find(([, factor]) => abs >= factor) ?? units[units.length - 1];
	const scaled = value / selected[1];
	return `${formatWaveformValue(scaled)} ${selected[0]}`;
}

function formatAxisTickValue(
	value: number,
	unit: string,
	scale: AxisScale,
	min?: number,
	max?: number,
): string {
	if (!Number.isFinite(value)) return "";
	if (scale === "log") return formatAxisValue(value, unit);

	const unitGroup = unitScaleGroup(unit);
	if (!unitGroup) {
		return `${formatWaveformValue(value)}${unit ? ` ${unit}` : ""}`;
	}

	const selected = selectAxisUnit(unitGroup, min, max, value);
	const factor = selected[1];
	const scaledValue = value / factor;
	return `${formatWaveformValue(scaledValue)} ${selected[0]}`;
}

function unitScaleGroup(unit: string): Array<[string, number]> | null {
	if (unit === "Hz") return [["GHz", 1e9], ["MHz", 1e6], ["kHz", 1e3], ["Hz", 1]];
	if (unit === "s") return [["s", 1], ["ms", 1e-3], ["us", 1e-6], ["ns", 1e-9], ["ps", 1e-12]];
	if (unit === "V") return [["kV", 1e3], ["V", 1], ["mV", 1e-3], ["uV", 1e-6]];
	if (unit === "A") return [["A", 1], ["mA", 1e-3], ["uA", 1e-6], ["nA", 1e-9]];
	return null;
}

function selectAxisUnit(
	units: Array<[string, number]>,
	min?: number,
	max?: number,
	value = 0,
): [string, number] {
	const span = visibleSpan(min, max);
	const reference = Math.max(
		Math.abs(Number.isFinite(min) ? Number(min) : 0),
		Math.abs(Number.isFinite(max) ? Number(max) : 0),
		Math.abs(value),
		Number.isFinite(span) ? span : 0,
	);
	return units.find(([, factor]) => reference >= factor) ?? units[units.length - 1];
}

function visibleSpan(min?: number, max?: number): number {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.NaN;
	return Math.abs(Number(max) - Number(min));
}

function normalizeAxisBoundary(value: number): number {
	if (!Number.isFinite(value)) return value;
	const abs = Math.abs(value);
	if (abs === 0 || abs >= 1e8 || abs < 1e-8) return value;
	return Number(value.toPrecision(14));
}

function significantResolution(reference: number, digits = 5): number {
	const abs = Math.abs(reference);
	if (!Number.isFinite(abs) || abs === 0) return 10 ** (1 - digits);
	return 10 ** (Math.floor(Math.log10(abs)) - digits + 1);
}

export function formatWaveformValue(value: number): string {
	if (!Number.isFinite(value)) return "";
	if (value === 0) return "0.0000";
	if (Math.abs(value) >= 1e-4) return value.toFixed(4);
	return value.toExponential(3)
		.replace(/(\.\d*?[1-9])0+e/i, "$1e")
		.replace(/\.0+e/i, "e");
}
