import {
	decodeReservedMeasurements,
	normalizeMeasurementId,
} from "../../core/analysis/reserved-measurements";
import type { SpiceEngine, SpiceMeasurement } from "../../core/simulation/spice-engine";
import { trimLogs } from "../../shared/logs";
import type { ProbeTarget } from "../../shared/probe";
import type { WaveformDataset } from "../../shared/waveform";
import { probeTraceNamesForProbes } from "./view-model";
import { buildMonteCarloSummaries } from "./stats";
import type {
	MonteCarloMeasurement,
	MonteCarloMeasurementConfig,
	MonteCarloResponse,
	MonteCarloSampleProgress,
	MonteCarloSampleResult,
} from "./types";
import { McWaveformStore } from "./waveform-store";

export interface RunMonteCarloOptions {
	sampleCount: number;
	seed?: number;
	probeNodes?: ProbeTarget[];
	compatMode?: string;
	/** 可选。每个样本完成后回调（实时渲染入口），store 为累积引用。 */
	onSampleProgress?: (progress: MonteCarloSampleProgress) => void;
	/** 可选。中止信号：abort 后在下一个样本前停止，已完成样本照常返回。 */
	signal?: AbortSignal;
}

interface DecodedMonteCarloSample {
	measurements: MonteCarloMeasurement[];
	configs: MonteCarloMeasurementConfig[];
	errors: string[];
}

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
		const waveformStore = new McWaveformStore();
		let captureFilter: ReadonlySet<string> | null = null;
		const pendingProbeNodes = options.probeNodes?.length ? options.probeNodes : null;
		let measurementConfigs: MonteCarloMeasurementConfig[] = [];
		let expectedMeasurementIds: string[] | null = null;
		let lastTrimCount = 0;

		for (let sampleIndex = 1; sampleIndex <= sampleCount; sampleIndex += 1) {
			if (options.signal?.aborted) {
				logs.push(`Monte Carlo stopped manually after ${samples.length} samples`);
				break;
			}
			try {
				const run = await session.run({
					beforeRun: [{ kind: "resample-source" }],
					captureWaveforms: true,
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
				if (datasets.length) {
					if (pendingProbeNodes && captureFilter === null) {
						const whitelist = probeTraceNamesForProbes(datasets[0], pendingProbeNodes);
						// 白名单为空说明探针与 trace 名不匹配，退回全量采集以免波形丢失。
						captureFilter = whitelist.size ? whitelist : null;
					}
					waveformStore.addSample(sampleIndex, datasets[0], captureFilter);
				}
				samples.push({
					sampleIndex,
					ok: true,
					measurements: decoded.measurements,
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
			finally {
				// 内存预算触发抽稀时记录日志。
				const trimCount = waveformStore.getTrimCount();
				if (trimCount > lastTrimCount) {
					lastTrimCount = trimCount;
					logs.push(`MC waveform memory budget exceeded; all samples decimated x2 (${trimCount} times, stride=${waveformStore.getStride()}, ~${Math.round(waveformStore.approxBytes() / 1048576)}MB)`);
				}
				// 实时渲染入口：每个样本结束（无论成败）都上报一次累积进度。
				if (options.onSampleProgress) {
					options.onSampleProgress({
						completed: sampleIndex,
						total: sampleCount,
						store: waveformStore,
						template: waveformStore.getTemplate(),
					});
					// 让出事件循环：await 延续在微任务队列，整圈循环会挤成一个宏任务，
					// rAF 没机会执行（表现为跑完才一次性出图）。MessageChannel 无 4ms 钳制。
					await yieldToEventLoop();
				}
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
			waveformStore,
			logs: trimLogs(logs),
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

/**
 * 让出事件循环（排到宏任务队列末尾），使浏览器有机会在样本之间执行
 * rAF/绘制。优先用 MessageChannel（无 setTimeout 嵌套 4ms 钳制）。
 */
function yieldToEventLoop(): Promise<void> {
	const channelCtor = (globalThis as {
		MessageChannel?: new () => {
			port1: { onmessage: (() => void) | null; close(): void };
			port2: { postMessage(value: number): void };
		};
	}).MessageChannel;
	if (channelCtor) {
		return new Promise((resolve) => {
			const channel = new channelCtor();
			channel.port1.onmessage = () => {
				channel.port1.close();
				resolve();
			};
			channel.port2.postMessage(0);
		});
	}
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function sameStringArray(left: string[], right: string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
