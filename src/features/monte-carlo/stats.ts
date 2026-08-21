import type {
	MonteCarloMeasurementConfig,
	MonteCarloSampleResult,
	MonteCarloSpecLimit,
	MonteCarloSummary,
} from "./types";

export function buildMonteCarloSummaries(
	samples: MonteCarloSampleResult[],
	measurementConfigs: MonteCarloMeasurementConfig[] = [],
): MonteCarloSummary[] {
	const configsById = new Map(measurementConfigs.map((config) => [normalizeId(config.id), config]));
	const labelsById = new Map<string, string>();
	const valuesById = new Map<string, number[]>();

	for (const sample of samples) {
		if (!sample.ok) continue;
		for (const measurement of sample.measurements) {
			if (!Number.isFinite(measurement.value)) continue;
			const id = normalizeId(measurement.id);
			if (!id) continue;
			if (!valuesById.has(id)) valuesById.set(id, []);
			valuesById.get(id)?.push(measurement.value);
			if (!labelsById.has(id)) labelsById.set(id, measurement.label || measurement.name || id);
		}
	}

	return [...valuesById.entries()]
		.map(([measurementId, values]) => summarizeValues(
			measurementId,
			configsById.get(measurementId)?.label || labelsById.get(measurementId) || measurementId,
			values,
			configsById.get(measurementId)?.spec,
			configsById.get(measurementId)?.unit,
		))
		.filter((summary): summary is MonteCarloSummary => Boolean(summary));
}

export function summarizeValues(
	measurementId: string,
	label: string,
	values: number[],
	spec?: MonteCarloSpecLimit,
	unit?: string,
): MonteCarloSummary | null {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;

	const count = sorted.length;
	const mean = sorted.reduce((sum, value) => sum + value, 0) / count;
	const varianceDenominator = count > 1 ? count - 1 : 1;
	const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / varianceDenominator;
	const yieldRate = spec ? sorted.filter((value) => withinSpec(value, spec)).length / count : undefined;

	return {
		measurementId,
		label,
		...(unit ? { unit } : {}),
		count,
		min: sorted[0],
		max: sorted[count - 1],
		mean,
		stdDev: Math.sqrt(variance),
		median: percentile(sorted, 0.5),
		p5: percentile(sorted, 0.05),
		p95: percentile(sorted, 0.95),
		...(yieldRate === undefined ? {} : { yieldRate }),
	};
}

function percentile(sorted: number[], fraction: number): number {
	if (!sorted.length) return Number.NaN;
	if (sorted.length === 1) return sorted[0];
	const clamped = Math.min(1, Math.max(0, fraction));
	const index = clamped * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	if (lower === upper) return sorted[lower];
	const weight = index - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function withinSpec(value: number, spec: MonteCarloSpecLimit): boolean {
	if (typeof spec.min === "number" && value < spec.min) return false;
	if (typeof spec.max === "number" && value > spec.max) return false;
	return true;
}

function normalizeId(value: string): string {
	return value.trim().toLowerCase();
}
