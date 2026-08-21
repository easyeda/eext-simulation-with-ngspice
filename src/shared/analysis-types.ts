export const SPICE_COMMAND_TYPES = ["transient", "ac", "dc"] as const;
export type SpiceCommandType = typeof SPICE_COMMAND_TYPES[number];

export const ANALYSIS_TYPES = [
	...SPICE_COMMAND_TYPES,
	"monte-carlo",
	"worst-case",
] as const;
export type AnalysisType = typeof ANALYSIS_TYPES[number];

export function isSpiceCommandType(value: unknown): value is SpiceCommandType {
	return typeof value === "string"
		&& (SPICE_COMMAND_TYPES as readonly string[]).includes(value);
}

export function isAnalysisType(value: unknown): value is AnalysisType {
	return typeof value === "string"
		&& (ANALYSIS_TYPES as readonly string[]).includes(value);
}
