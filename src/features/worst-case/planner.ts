import type { VariationParameter } from "../../shared/variation";
import type { WorstCaseParameterImpact, WorstCaseSummary } from "./types";

export interface WorstCaseCasePlan {
	id: string;
	kind: "nominal" | "parameter-min" | "parameter-max" | "worst-low" | "worst-high";
	parameterId?: string;
	assignments: Record<string, number>;
}

export interface ParameterBoundaryEvaluation {
	parameter: VariationParameter;
	objectiveAtMin: number;
	objectiveAtMax: number;
}

export function enabledWorstCaseParameters(parameters: VariationParameter[]): VariationParameter[] {
	return parameters.filter((parameter) => parameter.enabled);
}

export function expectedWorstCaseRunCount(parameters: VariationParameter[]): number {
	return 2 * enabledWorstCaseParameters(parameters).length + 3;
}

export function buildNominalAssignments(parameters: VariationParameter[]): Record<string, number> {
	return Object.fromEntries(enabledWorstCaseParameters(parameters).map((parameter) => [parameter.paramName, parameter.nominalValue]));
}

export function buildSensitivityCasePlans(parameters: VariationParameter[]): WorstCaseCasePlan[] {
	const enabled = enabledWorstCaseParameters(parameters);
	const nominal = buildNominalAssignments(enabled);
	const plans: WorstCaseCasePlan[] = [{ id: "nominal", kind: "nominal", assignments: nominal }];
	for (const parameter of enabled) {
		plans.push({
			id: `${parameter.id}-min`,
			kind: "parameter-min",
			parameterId: parameter.id,
			assignments: { ...nominal, [parameter.paramName]: parameter.minValue },
		});
		plans.push({
			id: `${parameter.id}-max`,
			kind: "parameter-max",
			parameterId: parameter.id,
			assignments: { ...nominal, [parameter.paramName]: parameter.maxValue },
		});
	}
	return plans;
}

export function buildParameterImpact(
	evaluation: ParameterBoundaryEvaluation,
	nominalObjective: number,
): WorstCaseParameterImpact {
	const { parameter, objectiveAtMin, objectiveAtMax } = evaluation;
	const epsilon = objectiveEpsilon(nominalObjective);
	const neutral = Math.abs(objectiveAtMin - objectiveAtMax) <= epsilon;
	return {
		parameterId: parameter.id,
		label: parameter.label,
		nominalValue: parameter.nominalValue,
		minValue: parameter.minValue,
		maxValue: parameter.maxValue,
		objectiveAtMin,
		objectiveAtMax,
		lowSelection: neutral ? "nominal" : objectiveAtMin < objectiveAtMax ? "min" : "max",
		highSelection: neutral ? "nominal" : objectiveAtMin > objectiveAtMax ? "min" : "max",
		impact: Math.max(Math.abs(objectiveAtMin - nominalObjective), Math.abs(objectiveAtMax - nominalObjective)),
	};
}

export function buildFinalCasePlans(
	parameters: VariationParameter[],
	impacts: WorstCaseParameterImpact[],
): [WorstCaseCasePlan, WorstCaseCasePlan] {
	const enabled = enabledWorstCaseParameters(parameters);
	const byId = new Map(impacts.map((impact) => [impact.parameterId, impact]));
	const lowAssignments: Record<string, number> = {};
	const highAssignments: Record<string, number> = {};
	for (const parameter of enabled) {
		const impact = byId.get(parameter.id);
		lowAssignments[parameter.paramName] = selectionValue(parameter, impact?.lowSelection ?? "nominal");
		highAssignments[parameter.paramName] = selectionValue(parameter, impact?.highSelection ?? "nominal");
	}
	return [
		{ id: "worst-low", kind: "worst-low", assignments: lowAssignments },
		{ id: "worst-high", kind: "worst-high", assignments: highAssignments },
	];
}

export function buildWorstCaseSummary(
	objectiveMeasurementId: string,
	nominalValue: number,
	worstLowValue: number,
	worstHighValue: number,
): WorstCaseSummary {
	const lowDelta = worstLowValue - nominalValue;
	const highDelta = worstHighValue - nominalValue;
	return {
		objectiveMeasurementId,
		nominalValue,
		worstLowValue,
		worstHighValue,
		lowDelta,
		highDelta,
		...(Math.abs(nominalValue) > objectiveEpsilon(nominalValue)
			? {
				lowDeltaPercent: lowDelta / Math.abs(nominalValue) * 100,
				highDeltaPercent: highDelta / Math.abs(nominalValue) * 100,
			}
			: {}),
	};
}

export function objectiveEpsilon(nominalValue: number): number {
	return Math.max(1e-12, Math.abs(nominalValue) * 1e-9);
}

export async function evaluateExhaustiveCornerOracle(
	parameters: VariationParameter[],
	evaluate: (assignments: Record<string, number>) => Promise<number> | number,
): Promise<{ nominal: number; min: number; max: number; runCount: number }> {
	const enabled = enabledWorstCaseParameters(parameters);
	if (enabled.length > 16) throw new Error("Exhaustive corner oracle is limited to 16 enabled parameters");
	const nominal = await evaluate(buildNominalAssignments(enabled));
	let min = nominal;
	let max = nominal;
	const combinations = 2 ** enabled.length;
	for (let mask = 0; mask < combinations; mask += 1) {
		const assignments = Object.fromEntries(enabled.map((parameter, index) => [
			parameter.paramName,
			(mask & (1 << index)) === 0 ? parameter.minValue : parameter.maxValue,
		]));
		const value = await evaluate(assignments);
		min = Math.min(min, value);
		max = Math.max(max, value);
	}
	return { nominal, min, max, runCount: combinations + 1 };
}

function selectionValue(parameter: VariationParameter, selection: "min" | "max" | "nominal"): number {
	if (selection === "min") return parameter.minValue;
	if (selection === "max") return parameter.maxValue;
	return parameter.nominalValue;
}
