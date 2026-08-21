import { classifyMeasurementName, normalizeMeasurementId } from "../../core/analysis/reserved-measurements";
import type { SpiceCommandType } from "../../shared/analysis-types";
import { findAnalysisDirectives, stripComments } from "../../shared/netlist";
import type { WorstCaseObjective } from "./types";

export interface WorstCaseValidationResult {
	ok: boolean;
	spiceCommandType?: SpiceCommandType;
	command?: string;
	errors: string[];
	warnings: string[];
}

export function validateWorstCaseInput(
	netlist: string,
	objective: WorstCaseObjective,
): WorstCaseValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];
	const directives = findAnalysisDirectives(netlist);

	if (!netlist.trim()) errors.push("Worst Case netlist is empty");
	if (!directives.length) errors.push("Worst Case netlist does not contain a .tran, .ac, or .dc command");
	if (directives.length > 1) errors.push("Worst Case netlist must contain exactly one .tran, .ac, or .dc command");
	if (containsControlBlock(netlist)) errors.push("Worst Case netlist must not contain a .control block");
	if (containsRandomParameterFunction(netlist)) errors.push("Worst Case netlist must use deterministic parameters, not random functions");

	const directive = directives.length === 1 ? directives[0] : undefined;
	validateObjective(objective, directive?.type, netlist, errors);
	validateReservedDeclarations(netlist, errors);

	return {
		ok: errors.length === 0,
		...(directive ? { spiceCommandType: directive.type, command: directive.command } : {}),
		errors,
		warnings,
	};
}

function validateObjective(
	objective: WorstCaseObjective,
	commandType: SpiceCommandType | undefined,
	netlist: string,
	errors: string[],
): void {
	if (!objective || typeof objective !== "object") {
		errors.push("Worst Case objective is required");
		return;
	}
	if (!objective.measurementId?.trim()) {
		errors.push("Worst Case objective.measurementId is required");
		return;
	}
	const classified = classifyMeasurementName(objective.measurementId);
	if (classified.kind !== "ordinary" && classified.kind !== "phase") {
		errors.push("Worst Case objective.measurementId must reference a non-reserved .meas result");
	}
	if (commandType && !hasMeasurement(netlist, objective.measurementId, commandType)) {
		errors.push(`Worst Case objective measurement ${objective.measurementId} was not found for ${commandType}`);
	}
}

function validateReservedDeclarations(netlist: string, errors: string[]): void {
	const names = listMeasurementNames(netlist);
	const parameterNames = new Set<string>();
	const minNames = new Set<string>();
	const maxNames = new Set<string>();
	const seenReserved = new Set<string>();

	for (const name of names) {
		const classified = classifyMeasurementName(name);
		if (classified.kind === "ordinary") continue;
		if (classified.kind === "invalid-reserved") {
			errors.push(classified.reason);
			continue;
		}
		const normalizedName = normalizeMeasurementId(name);
		if (seenReserved.has(normalizedName)) {
			errors.push(`Duplicate reserved measurement declaration: ${name}`);
			continue;
		}
		seenReserved.add(normalizedName);
		if (classified.kind === "parameter") parameterNames.add(classified.normalizedParamName);
		else if (classified.kind === "worst-case-min") minNames.add(classified.normalizedParamName);
		else if (classified.kind === "worst-case-max") maxNames.add(classified.normalizedParamName);
		else if (classified.kind === "phase") { /* 相位测量合法，无需参数配对 */ }
		else errors.push(`Worst Case netlist must not use Monte Carlo spec measurement ${name}`);
	}

	const allNames = new Set([...parameterNames, ...minNames, ...maxNames]);
	if (!allNames.size) {
		errors.push("Worst Case requires at least one reserved parameter measurement group");
		return;
	}
	for (const name of allNames) {
		if (!parameterNames.has(name)) errors.push(`Worst Case parameter ${name} is missing __JLC_PARAM_${name}`);
		if (!minNames.has(name)) errors.push(`Worst Case parameter ${name} is missing __JLC_WC_MIN_${name}`);
		if (!maxNames.has(name)) errors.push(`Worst Case parameter ${name} is missing __JLC_WC_MAX_${name}`);
	}
}

function listMeasurementNames(netlist: string): string[] {
	const names: string[] = [];
	for (const line of stripComments(netlist).split(/\r?\n/)) {
		const match = /^\s*\.meas(?:ure)?\s+\S+\s+([^\s]+)/i.exec(line);
		if (match) names.push(match[1]);
	}
	return names;
}

function hasMeasurement(netlist: string, id: string, type: SpiceCommandType): boolean {
	const keyword = type === "transient" ? "tran" : type;
	const escaped = escapeRegExp(id.trim());
	return new RegExp(`^\\s*\\.meas(?:ure)?\\s+${keyword}\\s+${escaped}\\b`, "im").test(stripComments(netlist));
}

function containsControlBlock(netlist: string): boolean {
	return /^\s*\.control\b/im.test(stripComments(netlist));
}

function containsRandomParameterFunction(netlist: string): boolean {
	return /\b(?:a?gauss|unif|aunif|rand|random)\s*\(/i.test(stripComments(netlist));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
