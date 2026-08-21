import type { MonteCarloResult, MonteCarloSampleResult } from "./types";

export function monteCarloResultToCsv(result: MonteCarloResult): string {
	const measurementIds = collectSampleMeasurementIds(result.samples);
	const unitsById = collectMeasurementUnits(result.samples);
	const headers = [
		"seed",
		"sampleIndex",
		"ok",
		...measurementIds.map((id) => unitsById.has(id) ? `${id} (${unitsById.get(id)})` : id),
		"error",
	];
	const rows = result.samples.map((sample) => {
		const valuesById = new Map(sample.measurements.map((measurement) => [measurement.id, measurement.value]));
		return [
			String(result.seed),
			String(sample.sampleIndex),
			sample.ok ? "true" : "false",
			...measurementIds.map((id) => valuesById.has(id) ? String(valuesById.get(id)) : ""),
			sample.error || "",
		];
	});
	return [headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}

export function collectSampleMeasurementIds(samples: MonteCarloSampleResult[]): string[] {
	const ids = new Set<string>();
	for (const sample of samples) {
		for (const measurement of sample.measurements) ids.add(measurement.id);
	}
	return [...ids];
}

function collectMeasurementUnits(samples: MonteCarloSampleResult[]): Map<string, string> {
	const units = new Map<string, string>();
	for (const sample of samples) {
		for (const measurement of sample.measurements) {
			if (measurement.unit && !units.has(measurement.id)) units.set(measurement.id, measurement.unit);
		}
	}
	return units;
}

function csvCell(value: string): string {
	return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
