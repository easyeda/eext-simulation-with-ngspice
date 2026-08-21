import type {
	MonteCarloMeasurementConfig,
	MonteCarloResult,
	MonteCarloSpecLimit,
	MonteCarloSummary,
} from './types';

export interface HistogramSampleValue {
	sampleIndex: number;
	value: number;
}

export interface HistogramMeasurement {
	id: string;
	label: string;
	/** 可选。测量值单位，如相位测量的 "deg"。 */
	unit?: string;
	values: HistogramSampleValue[];
	summary: MonteCarloSummary;
	spec?: MonteCarloSpecLimit;
}

export interface HistogramBin {
	index: number;
	lower: number;
	upper: number;
	count: number;
	sampleIndices: number[];
}

const MIN_BIN_COUNT = 6;
const MAX_BIN_COUNT = 40;

export function buildHistogramMeasurements(
	result: MonteCarloResult,
	configs: MonteCarloMeasurementConfig[] = [],
): HistogramMeasurement[] {
	const configsById = new Map(configs.map((config) => [normalizeId(config.id), config]));
	const summariesById = new Map(result.summaries.map((summary) => [normalizeId(summary.measurementId), summary]));
	const valuesById = new Map<string, HistogramSampleValue[]>();

	for (const sample of result.samples) {
		if (!sample.ok) continue;
		for (const measurement of sample.measurements) {
			if (!Number.isFinite(measurement.value)) continue;
			const id = normalizeId(measurement.id);
			if (!id || !summariesById.has(id)) continue;
			if (!valuesById.has(id)) valuesById.set(id, []);
			valuesById.get(id)?.push({ sampleIndex: sample.sampleIndex, value: measurement.value });
		}
	}

	return result.summaries.flatMap((summary) => {
		const id = normalizeId(summary.measurementId);
		const values = valuesById.get(id) || [];
		if (!values.length) return [];
		const config = configsById.get(id);
		return [{
			id,
			label: config?.label || summary.label || summary.measurementId,
			...(config?.unit || summary.unit ? { unit: config?.unit || summary.unit } : {}),
			values,
			summary,
			...(config?.spec ? { spec: config.spec } : {}),
		}];
	});
}

export function buildHistogramBins(values: HistogramSampleValue[]): HistogramBin[] {
	const finite = values.filter((item) => Number.isFinite(item.value));
	if (!finite.length) return [];
	const sorted = [...finite].sort((a, b) => a.value - b.value);
	const minimum = sorted[0].value;
	const maximum = sorted[sorted.length - 1].value;
	const range = maximum - minimum;

	if (!Number.isFinite(range) || range <= Number.EPSILON * Math.max(1, Math.abs(minimum), Math.abs(maximum))) {
		const padding = Math.max(Math.abs(minimum) * 0.01, 0.5);
		return [{
			index: 0,
			lower: minimum - padding,
			upper: maximum + padding,
			count: sorted.length,
			sampleIndices: sorted.map((item) => item.sampleIndex),
		}];
	}

	const q1 = percentile(sorted.map((item) => item.value), 0.25);
	const q3 = percentile(sorted.map((item) => item.value), 0.75);
	const fdWidth = 2 * (q3 - q1) / Math.cbrt(sorted.length);
	const sturgesCount = Math.ceil(Math.log2(sorted.length) + 1);
	const estimatedCount = Number.isFinite(fdWidth) && fdWidth > 0
		? Math.ceil(range / fdWidth)
		: sturgesCount;
	const binCount = clamp(Math.max(estimatedCount, sturgesCount), MIN_BIN_COUNT, MAX_BIN_COUNT);
	const width = range / binCount;
	const bins: HistogramBin[] = Array.from({ length: binCount }, (_, index) => ({
		index,
		lower: minimum + index * width,
		upper: index === binCount - 1 ? maximum : minimum + (index + 1) * width,
		count: 0,
		sampleIndices: [],
	}));

	for (const item of finite) {
		const rawIndex = item.value === maximum ? binCount - 1 : Math.floor((item.value - minimum) / width);
		const index = clamp(rawIndex, 0, binCount - 1);
		bins[index].count += 1;
		bins[index].sampleIndices.push(item.sampleIndex);
	}
	return bins;
}

function percentile(sorted: number[], fraction: number): number {
	if (sorted.length === 1) return sorted[0];
	const index = clamp(fraction, 0, 1) * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower];
	const weight = index - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function normalizeId(value: string): string {
	return value.trim().toLowerCase();
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
