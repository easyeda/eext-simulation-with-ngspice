import type { SpiceCommandType } from "../../shared/analysis-types";
import type { VariationParameter } from "../../shared/variation";
import type { WaveformDataset } from "../../shared/waveform";

export interface WorstCaseObjective {
	measurementId: string;
	label: string;
	unit?: string;
}

export type WorstCaseRunKind =
	| "nominal"
	| "parameter-min"
	| "parameter-max"
	| "worst-low"
	| "worst-high";

export type WorstCaseResultStatus = "complete" | "incomplete" | "failed";

export interface WorstCaseMeasurement {
	id: string;
	name: string;
	label: string;
	value: number;
	unit?: string;
	raw?: string;
}

export interface WorstCaseRunResult {
	id: string;
	kind: WorstCaseRunKind;
	ok: boolean;
	parameterId?: string;
	spiceCommandType: SpiceCommandType;
	assignments: Record<string, number>;
	measurements: WorstCaseMeasurement[];
	datasets?: WaveformDataset[];
	logs?: string[];
	error?: string;
}

export interface WorstCaseParameterImpact {
	parameterId: string;
	label: string;
	nominalValue: number;
	minValue: number;
	maxValue: number;
	objectiveAtMin: number;
	objectiveAtMax: number;
	lowSelection: "min" | "max" | "nominal";
	highSelection: "min" | "max" | "nominal";
	impact: number;
}

export interface WorstCaseSummary {
	objectiveMeasurementId: string;
	nominalValue: number;
	worstLowValue: number;
	worstHighValue: number;
	lowDelta: number;
	highDelta: number;
	lowDeltaPercent?: number;
	highDeltaPercent?: number;
}

export interface WorstCaseResult {
	status: WorstCaseResultStatus;
	analysisType: "worst-case";
	spiceCommandType: SpiceCommandType;
	command: string;
	strategy: "one-at-a-time-corner";
	direction: "both";
	objective: WorstCaseObjective;
	parameters: VariationParameter[];
	expectedRunCount: number;
	completedRunCount: number;
	summary?: WorstCaseSummary;
	parameterImpacts: WorstCaseParameterImpact[];
	runs: WorstCaseRunResult[];
	finalDatasets: WaveformDataset[];
	logs: string[];
}

export interface WorstCaseResponse {
	ok: boolean;
	result?: WorstCaseResult;
	logs: string[];
	error?: string;
}
