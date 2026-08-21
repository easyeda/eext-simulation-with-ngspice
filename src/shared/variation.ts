export type VariationParameterScope =
	| "global-param"
	| "subckt-param"
	| "device-param"
	| "model-param";

export type ToleranceSource =
	| {
		kind: "relative";
		lowerPercent: number;
		upperPercent: number;
	}
	| {
		kind: "absolute";
		lowerDelta: number;
		upperDelta: number;
		unit?: string;
	}
	| {
		kind: "resolved-bounds";
	};

export interface VariationDistribution {
	kind: "uniform" | "gaussian";
	sigmaRule?: "tolerance-is-3sigma";
}

export interface VariationParameter {
	id: string;
	label: string;
	enabled: boolean;
	scope: VariationParameterScope;
	paramName: string;
	nominalValue: number;
	minValue: number;
	maxValue: number;
	unit?: string;
	tolerance: ToleranceSource;
	distribution?: VariationDistribution;
	owner?: {
		id: string;
		refdes?: string;
		modelName?: string;
		hierarchicalPath?: string;
	};
}
