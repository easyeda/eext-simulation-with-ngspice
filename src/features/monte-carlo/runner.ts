import {
	decodeReservedMeasurements,
	normalizeMeasurementId,
} from "../../core/analysis/reserved-measurements";
import type { SpiceEngine, SpiceMeasurement } from "../../core/simulation/spice-engine";
import { trimLogs } from "../../shared/logs";
import type { ProbeTarget } from "../../shared/probe";
import type { WaveformDataset } from "../../shared/waveform";
import { buildMonteCarloSummaries } from "./stats";
import type {
	MonteCarloMeasurement,
	MonteCarloMeasurementConfig,
	MonteCarloResponse,
	MonteCarloSampleResult,
} from "./types";

export interface RunMonteCarloOptions {
	sampleCount: number;
	seed?: number;
	probeNodes?: ProbeTarget[];
	compatMode?: string;
}

interface DecodedMonteCarloSample {
	measurements: MonteCarloMeasurement[];
	configs: MonteCarloMeasurementConfig[];
	errors: string[];
}

const MAX_WAVEFORM_SAMPLES = 200;
const MAX_NGSPICE_SEED = 2_147_483_646;

export async function runMonteCarloAnalysis(
	engine: SpiceEngine,
	netlist: string,
	options: RunMonteCarloOptions,
): Promise<MonteCarloResponse> {
	const logs: string[] = [`Run mode: ${engine.id} Monte Carlo`];
	const sampleCount = Math.trunc(options.sampleCount);
	if (!netlist.trim()) return { ok: false, logs, error: "Netlist is empty" };
	if (!Number.isSafeInteger(options.sampleCount) || sampleCount <= 0) {
		return { ok: false, logs, error: "Monte Carlo sampleCount must be a positive safe integer" };
	}
	if (options.seed !== undefined && (!Number.isSafeInteger(options.seed) || options.seed <= 0 || options.seed > MAX_NGSPICE_SEED)) {
		return { ok: false, logs, error: `Monte Carlo seed must be an integer from 1 to ${MAX_NGSPICE_SEED}` };
	}

	const seed = options.seed ?? generateSeed();
	let session: Awaited<ReturnType<SpiceEngine["open"]>>["session"] | null = null;
	try {
		const opened = await engine.open(netlist, { probeNodes: options.probeNodes, compatMode: options.compatMode });
		session = opened.session;
		logs.push(...opened.logs);
		session.setRandomSeed(seed);
		logs.push(`Monte Carlo seed: ${seed}`);

		const samples: MonteCarloSampleResult[] = [];
		const representativeDatasets: WaveformDataset[] = [];
		let measurementConfigs: MonteCarloMeasurementConfig[] = [];
		let expectedMeasurementIds: string[] | null = null;

		for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
			try {
				const captureWaveforms = sampleIndex <= MAX_WAVEFORM_SAMPLES;
				const run = await session.run({
					beforeRun: [{ kind: "resample-source" }],
					captureWaveforms,
				});
				if (!run.ok) {
					samples.push({
						sampleIndex,
						ok: false,
						measurements: [],
						error: run.error || "SPICE sample failed",
						logs: trimLogs(run.logs),
					});
					continue;
				}

				const decoded = decodeMonteCarloSample(run.measurements);
				if (decoded.errors.length) {
					samples.push({
						sampleIndex,
						ok: false,
						measurements: [],
						error: decoded.errors.join("\n"),
						logs: trimLogs([...run.logs, ...decoded.errors]),
					});
					continue;
				}
				const measurementIds = decoded.measurements.map((measurement) => measurement.id).sort();
				if (expectedMeasurementIds && !sameStringArray(expectedMeasurementIds, measurementIds)) {
					const error = "Monte Carlo measurement set changed between samples";
					samples.push({
						sampleIndex,
						ok: false,
						measurements: [],
						error,
						logs: trimLogs([...run.logs, error]),
					});
					continue;
				}
				if (!expectedMeasurementIds) {
					expectedMeasurementIds = measurementIds;
					measurementConfigs = decoded.configs;
				}

				const datasets = run.datasets.map((dataset) => ({
					...dataset,
					productAnalysisType: "monte-carlo" as const,
				}));
				if (!representativeDatasets.length && datasets.length) representativeDatasets.push(...datasets);
				samples.push({
					sampleIndex,
					ok: true,
					measurements: decoded.measurements,
					...(datasets.length ? { datasets } : {}),
					...(run.logs.length ? { logs: trimLogs(run.logs) } : {}),
				});
			}
			catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				samples.push({
					sampleIndex,
					ok: false,
					measurements: [],
					error: message,
					logs: trimLogs([message]),
				});
			}
		}

		const summaries = buildMonteCarloSummaries(samples, measurementConfigs);
		const successCount = samples.filter((sample) => sample.ok).length;
		const failedCount = samples.length - successCount;
		logs.push(`Monte Carlo samples finished: ${successCount}/${samples.length} succeeded`);
		if (failedCount) logs.push(`Monte Carlo failed samples: ${failedCount}`);

		const result = {
			seed,
			samples,
			summaries,
			measurementConfigs,
			representativeDatasets,
			logs: trimLogs(logs),
			waveformSampleLimit: MAX_WAVEFORM_SAMPLES,
		};
		if (!successCount) {
			return { ok: false, result, logs: trimLogs(logs), error: "All Monte Carlo samples failed" };
		}
		if (!summaries.length) {
			const error = "No Monte Carlo parameter or output measurements were parsed";
			return { ok: false, result, logs: trimLogs([...logs, error]), error };
		}
		return { ok: true, result, logs: trimLogs(logs) };
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			logs: trimLogs([...logs, `${engine.id} Monte Carlo failed: ${message}`]),
			error: message,
		};
	}
	finally {
		session?.dispose();
	}
}

function decodeMonteCarloSample(measurements: SpiceMeasurement[]): DecodedMonteCarloSample {
	const decoded = decodeReservedMeasurements(measurements);
	const errors = [...decoded.errors];
	const configs: MonteCarloMeasurementConfig[] = [];
	const values: MonteCarloMeasurement[] = [];

	for (const [id, entry] of decoded.parameters) {
		values.push({
			id: `parameter:${id}`,
			name: entry.paramName,
			label: entry.paramName,
			source: "parameter",
			value: entry.measurement.value,
			...(entry.measurement.raw ? { raw: entry.measurement.raw } : {}),
		});
		configs.push({
			id: `parameter:${id}`,
			label: entry.paramName,
			source: "parameter",
		});
	}

	// 普通输出测量与相位测量统一处理；相位测量的值已在 core 层换算为度。
	const outputIds = new Set<string>();
	const outputMeasurements: Array<{
		id: string;
		name: string;
		value: number;
		unit?: string;
		raw?: string;
	}> = [];

	for (const measurement of decoded.ordinary) {
		outputMeasurements.push({
			id: normalizeMeasurementId(measurement.name),
			name: measurement.name,
			value: measurement.value,
			...(measurement.raw ? { raw: measurement.raw } : {}),
		});
	}
	for (const [id, entry] of decoded.phase) {
		outputMeasurements.push({
			id,
			name: entry.phaseName,
			value: entry.measurement.value,
			unit: "deg",
			...(entry.measurement.raw ? { raw: entry.measurement.raw } : {}),
		});
	}

	for (const output of outputMeasurements) {
		outputIds.add(output.id);
		const min = decoded.specMin.get(output.id)?.measurement.value;
		const max = decoded.specMax.get(output.id)?.measurement.value;
		if (min !== undefined && max !== undefined && min > max) {
			errors.push(`Monte Carlo spec ${output.name} must satisfy min <= max`);
		}
		values.push({
			id: output.id,
			name: output.name,
			label: output.name,
			source: "output",
			value: output.value,
			...(output.unit ? { unit: output.unit } : {}),
			...(output.raw ? { raw: output.raw } : {}),
		});
		configs.push({
			id: output.id,
			label: output.name,
			source: "output",
			...(output.unit ? { unit: output.unit } : {}),
			...(min === undefined && max === undefined
				? {}
				: {
					spec: {
						...(min === undefined ? {} : { min }),
						...(max === undefined ? {} : { max }),
					},
				}),
		});
	}

	for (const [id, entry] of decoded.specMin) {
		if (!outputIds.has(id)) errors.push(`Spec minimum ${entry.measurement.name} has no matching output measurement`);
	}
	for (const [id, entry] of decoded.specMax) {
		if (!outputIds.has(id)) errors.push(`Spec maximum ${entry.measurement.name} has no matching output measurement`);
	}

	return { measurements: values, configs, errors };
}

function generateSeed(): number {
	return Math.floor(Math.random() * MAX_NGSPICE_SEED) + 1;
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
