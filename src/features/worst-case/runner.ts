import {
	classifyMeasurementName,
	decodeReservedMeasurements,
	normalizeMeasurementId,
} from "../../core/analysis/reserved-measurements";
import type {
	SpiceEngine,
	SpiceExecutionSession,
	SpiceMeasurement,
	SpiceRunResult,
} from "../../core/simulation/spice-engine";
import { trimLogs } from "../../shared/logs";
import type { ProbeTarget } from "../../shared/probe";
import type { VariationParameter } from "../../shared/variation";
import type { WaveformDataset } from "../../shared/waveform";
import { worstCaseTechnicalKindLabel } from "./case-label";
import {
	buildFinalCasePlans,
	buildNominalAssignments,
	buildParameterImpact,
	buildSensitivityCasePlans,
	buildWorstCaseSummary,
	expectedWorstCaseRunCount,
	type WorstCaseCasePlan,
} from "./planner";
import type {
	WorstCaseMeasurement,
	WorstCaseObjective,
	WorstCaseResponse,
	WorstCaseRunResult,
} from "./types";
import { validateWorstCaseInput } from "./validation";

export interface RunWorstCaseOptions {
	objective: WorstCaseObjective;
	probeNodes?: ProbeTarget[];
	compatMode?: string;
}

interface ParameterDiscovery {
	parameters: VariationParameter[];
	errors: string[];
}

export async function runWorstCaseAnalysis(
	engine: SpiceEngine,
	netlist: string,
	options: RunWorstCaseOptions,
): Promise<WorstCaseResponse> {
	const logs: string[] = [`Run mode: ${engine.id} Worst Case`];
	const objective = resolveWorstCaseObjective(options);
	const validation = validateWorstCaseInput(netlist, options.objective);
	logs.push(...validation.warnings.map((warning) => `warning: ${warning}`));
	if (!validation.ok || !validation.spiceCommandType || !validation.command) {
		const error = validation.errors.join("\n") || "Worst Case validation failed";
		return { ok: false, logs: trimLogs([...logs, ...validation.errors]), error };
	}

	let session: SpiceExecutionSession | null = null;
	const runs: WorstCaseRunResult[] = [];
	try {
		const opened = await engine.open(netlist, { probeNodes: options.probeNodes, compatMode: options.compatMode });
		session = opened.session;
		logs.push(...opened.logs);

		const nominalExecution = await session.run({ captureWaveforms: true });
		if (!nominalExecution.ok) {
			const error = nominalExecution.error || "Worst Case nominal SPICE run failed";
			return { ok: false, logs: trimLogs([...logs, ...nominalExecution.logs, error]), error };
		}

		const discovery = discoverWorstCaseParameters(nominalExecution.measurements);
		if (discovery.errors.length) {
			const error = discovery.errors.join("\n");
			return { ok: false, logs: trimLogs([...logs, ...nominalExecution.logs, ...discovery.errors]), error };
		}
		const parameters = discovery.parameters;
		const expectedRunCount = expectedWorstCaseRunCount(parameters);
		logs.push(`Worst Case parameters discovered: ${parameters.length}`);
		logs.push(`Worst Case expected runs: ${expectedRunCount}`);

		const nominalPlan: WorstCaseCasePlan = {
			id: "nominal",
			kind: "nominal",
			assignments: buildNominalAssignments(parameters),
		};
		const nominal = buildCaseResult(
			nominalExecution,
			nominalPlan,
			validation.spiceCommandType,
			objective,
			true,
		);
		runs.push(nominal);
		logs.push(...(nominal.logs ?? []));
		const nominalObjective = objectiveValue(nominal, objective.measurementId);
		if (!nominal.ok || nominalObjective === null) {
			const error = nominal.error || `Nominal run did not return objective ${objective.measurementId}`;
			return {
				ok: false,
				result: buildPartialResult(
					"failed",
					validation.spiceCommandType,
					validation.command,
					objective,
					parameters,
					expectedRunCount,
					runs,
					[],
					logs,
				),
				logs: trimLogs([...logs, error]),
				error,
			};
		}

		for (const plan of buildSensitivityCasePlans(parameters).slice(1)) {
			const run = await executeCase(
				session,
				plan,
				validation.spiceCommandType,
				objective,
				false,
			);
			runs.push(run);
			logs.push(...(run.logs ?? []));
		}

		const impacts = parameters.flatMap((parameter) => {
			const minRun = runs.find((run) => run.parameterId === parameter.id && run.kind === "parameter-min");
			const maxRun = runs.find((run) => run.parameterId === parameter.id && run.kind === "parameter-max");
			const objectiveAtMin = minRun ? objectiveValue(minRun, objective.measurementId) : null;
			const objectiveAtMax = maxRun ? objectiveValue(maxRun, objective.measurementId) : null;
			if (!minRun?.ok || !maxRun?.ok || objectiveAtMin === null || objectiveAtMax === null) return [];
			return [buildParameterImpact({ parameter, objectiveAtMin, objectiveAtMax }, nominalObjective)];
		});

		const [worstLowPlan, worstHighPlan] = buildFinalCasePlans(parameters, impacts);
		const worstLow = await executeCase(
			session,
			worstLowPlan,
			validation.spiceCommandType,
			objective,
			true,
		);
		const worstHigh = await executeCase(
			session,
			worstHighPlan,
			validation.spiceCommandType,
			objective,
			true,
		);
		runs.push(worstLow, worstHigh);
		logs.push(...(worstLow.logs ?? []), ...(worstHigh.logs ?? []));

		const worstLowValue = objectiveValue(worstLow, objective.measurementId);
		const worstHighValue = objectiveValue(worstHigh, objective.measurementId);
		const complete = impacts.length === parameters.length
			&& runs.length === expectedRunCount
			&& runs.every((run) => run.ok)
			&& worstLowValue !== null
			&& worstHighValue !== null;
		const status = complete ? "complete" : "incomplete";
		const result = {
			...buildPartialResult(
				status,
				validation.spiceCommandType,
				validation.command,
				objective,
				parameters,
				expectedRunCount,
				runs,
				impacts,
				logs,
			),
			...(worstLowValue !== null && worstHighValue !== null
				? {
					summary: buildWorstCaseSummary(
						objective.measurementId,
						nominalObjective,
						worstLowValue,
						worstHighValue,
					),
				}
				: {}),
			finalDatasets: collectFinalDatasets(runs),
		};
		logs.push(`Worst Case runs finished: ${result.completedRunCount}/${expectedRunCount} succeeded`);
		if (!complete) logs.push("Worst Case result is incomplete");
		result.logs = trimLogs(logs);
		return {
			ok: complete,
			result,
			logs: trimLogs(logs),
			...(complete ? {} : { error: "Worst Case result is incomplete" }),
		};
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			logs: trimLogs([...logs, `${engine.id} Worst Case failed: ${message}`]),
			error: message,
		};
	}
	finally {
		session?.dispose();
	}
}

async function executeCase(
	session: SpiceExecutionSession,
	plan: WorstCaseCasePlan,
	spiceCommandType: "transient" | "ac" | "dc",
	objective: WorstCaseObjective,
	captureWaveform: boolean,
): Promise<WorstCaseRunResult> {
	const execution = await session.run({
		beforeRun: [{ kind: "alter-parameters", values: plan.assignments }],
		captureWaveforms: captureWaveform,
	});
	return buildCaseResult(execution, plan, spiceCommandType, objective, captureWaveform);
}

function buildCaseResult(
	execution: SpiceRunResult,
	plan: WorstCaseCasePlan,
	spiceCommandType: "transient" | "ac" | "dc",
	objective: WorstCaseObjective,
	captureWaveform: boolean,
): WorstCaseRunResult {
	const logs = execution.logs.map((message) => `${plan.id}: ${message}`);
	if (!execution.ok) {
		const error = execution.error || "SPICE case failed";
		return failedCase(plan, spiceCommandType, error, logs);
	}
	const decoded = decodeReservedMeasurements(execution.measurements);
	if (decoded.errors.length) {
		return failedCase(plan, spiceCommandType, decoded.errors.join("\n"), [...logs, ...decoded.errors]);
	}
	// 相位测量（__JLC_PHASE_ 前缀）在 core 层已换算为度，作为普通测量一并参与
	// objective 匹配；其单位标记为 deg。
	const phaseIds = new Set(decoded.phase.keys());
	const measurements = readWorstCaseMeasurements(
		[
			...decoded.ordinary,
			...[ ...decoded.phase.entries() ].map(([, entry]) => ({
				name: entry.phaseName,
				value: entry.measurement.value,
				...(entry.measurement.raw ? { raw: entry.measurement.raw } : {}),
			})),
		],
		objective,
		phaseIds,
	);
	const objectiveMeasurement = measurements.find(
		(measurement) => measurement.id === normalizeMeasurementId(objective.measurementId),
	);
	if (!objectiveMeasurement) {
		return failedCase(
			plan,
			spiceCommandType,
			`Objective measurement ${objective.measurementId} was not returned`,
			logs,
		);
	}
	const datasets = captureWaveform ? tagWorstCaseDatasets(execution.datasets, plan) : [];
	logs.push(`${plan.id}: objective=${formatNumber(objectiveMeasurement.value)}`);
	return {
		id: plan.id,
		kind: plan.kind,
		ok: true,
		...(plan.parameterId ? { parameterId: plan.parameterId } : {}),
		spiceCommandType,
		assignments: { ...plan.assignments },
		measurements,
		...(datasets.length ? { datasets } : {}),
		logs,
	};
}

/**
 * 解析相位 objective：EDA 传的 measurementId 可以带 __JLC_PHASE_ 前缀（例如
 * __JLC_PHASE_PHASE_100），这里剥离前缀得到真实测量名，并默认单位为 deg。
 */
export function resolveWorstCaseObjective(options: RunWorstCaseOptions): WorstCaseObjective {
	const classified = classifyMeasurementName(options.objective.measurementId);
	if (classified.kind === "phase") {
		return {
			measurementId: classified.phaseName,
			label: options.objective.label || classified.phaseName,
			unit: options.objective.unit || "deg",
		};
	}
	return options.objective;
}

function discoverWorstCaseParameters(measurements: SpiceMeasurement[]): ParameterDiscovery {
	const decoded = decodeReservedMeasurements(measurements);
	const errors = [...decoded.errors];
	const parameters: VariationParameter[] = [];
	const names = new Set([
		...decoded.parameters.keys(),
		...decoded.worstCaseMin.keys(),
		...decoded.worstCaseMax.keys(),
	]);

	for (const name of names) {
		const actual = decoded.parameters.get(name);
		const minimum = decoded.worstCaseMin.get(name);
		const maximum = decoded.worstCaseMax.get(name);
		if (!actual) errors.push(`Worst Case parameter ${name} did not return __JLC_PARAM_${name}`);
		if (!minimum) errors.push(`Worst Case parameter ${name} did not return __JLC_WC_MIN_${name}`);
		if (!maximum) errors.push(`Worst Case parameter ${name} did not return __JLC_WC_MAX_${name}`);
		if (!actual || !minimum || !maximum) continue;

		const nominalValue = actual.measurement.value;
		const minValue = minimum.measurement.value;
		const maxValue = maximum.measurement.value;
		if (![nominalValue, minValue, maxValue].every(Number.isFinite)) {
			errors.push(`Worst Case parameter ${actual.paramName} bounds must be finite`);
			continue;
		}
		if (minValue > nominalValue || nominalValue > maxValue) {
			errors.push(`Worst Case parameter ${actual.paramName} must satisfy min <= nominal <= max`);
			continue;
		}
		parameters.push({
			id: name,
			label: actual.paramName,
			enabled: true,
			scope: "global-param",
			paramName: actual.paramName,
			nominalValue,
			minValue,
			maxValue,
			tolerance: { kind: "resolved-bounds" },
		});
	}
	if (!parameters.length && !errors.length) {
		errors.push("Worst Case nominal run returned no reserved parameter measurements");
	}
	return { parameters, errors };
}

function readWorstCaseMeasurements(
	measurements: SpiceMeasurement[],
	objective: WorstCaseObjective,
	phaseIds: Set<string> = new Set(),
): WorstCaseMeasurement[] {
	const objectiveId = normalizeMeasurementId(objective.measurementId);
	return measurements.map((measurement) => {
		const id = normalizeMeasurementId(measurement.name);
		const isObjective = id === objectiveId;
		const phaseUnit = phaseIds.has(id) ? "deg" : undefined;
		return {
			id,
			name: measurement.name,
			label: isObjective ? objective.label : measurement.name,
			value: measurement.value,
			...(isObjective && objective.unit ? { unit: objective.unit } : phaseUnit ? { unit: phaseUnit } : {}),
			...(measurement.raw ? { raw: measurement.raw } : {}),
		};
	});
}

function failedCase(
	plan: WorstCaseCasePlan,
	spiceCommandType: "transient" | "ac" | "dc",
	error: string,
	logs: string[],
): WorstCaseRunResult {
	return {
		id: plan.id,
		kind: plan.kind,
		ok: false,
		...(plan.parameterId ? { parameterId: plan.parameterId } : {}),
		spiceCommandType,
		assignments: { ...plan.assignments },
		measurements: [],
		logs: trimLogs([...logs, `${plan.id}: ${error}`]),
		error,
	};
}

function objectiveValue(run: WorstCaseRunResult, measurementId: string): number | null {
	const measurement = run.measurements.find((item) => item.id === normalizeMeasurementId(measurementId));
	return measurement && Number.isFinite(measurement.value) ? measurement.value : null;
}

function tagWorstCaseDatasets(datasets: WaveformDataset[], plan: WorstCaseCasePlan): WaveformDataset[] {
	return datasets.map((dataset, index) => ({
		...dataset,
		id: `wc-${plan.id}-${dataset.id}-${index + 1}`,
		productAnalysisType: "worst-case" as const,
		title: worstCaseTechnicalKindLabel(plan.kind, plan.id),
		meta: { ...dataset.meta, sourcePlot: plan.id },
	}));
}

function collectFinalDatasets(runs: WorstCaseRunResult[]): WaveformDataset[] {
	return runs
		.filter((run) => run.kind === "nominal" || run.kind === "worst-low" || run.kind === "worst-high")
		.flatMap((run) => run.datasets ?? []);
}

function buildPartialResult(
	status: "complete" | "incomplete" | "failed",
	spiceCommandType: "transient" | "ac" | "dc",
	command: string,
	objective: WorstCaseObjective,
	parameters: VariationParameter[],
	expectedRunCount: number,
	runs: WorstCaseRunResult[],
	parameterImpacts: ReturnType<typeof buildParameterImpact>[],
	logs: string[],
) {
	return {
		status,
		analysisType: "worst-case" as const,
		spiceCommandType,
		command,
		strategy: "one-at-a-time-corner" as const,
		direction: "both" as const,
		objective,
		parameters,
		expectedRunCount,
		completedRunCount: runs.filter((run) => run.ok).length,
		parameterImpacts,
		runs,
		finalDatasets: collectFinalDatasets(runs),
		logs: trimLogs(logs),
	};
}

function formatNumber(value: number): string {
	if (!Number.isFinite(value)) throw new Error("Worst Case value must be finite");
	return value === 0 ? "0" : value.toExponential(15).replace(/\.?0+e/, "e");
}
