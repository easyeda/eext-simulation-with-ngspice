export const RESERVED_MEASUREMENT_PREFIX = "__JLC_";

/**
 * ngspice 的 .meas ... FIND vp(...) 返回相位弧度，波形层显示的是度数。
 * 网表用 __JLC_PHASE_ 前缀显式声明"该测量是相位"，解码时按此系数换算为度。
 */
export const RADIAN_TO_DEGREE = 180 / Math.PI;

export interface MeasurementValue {
	name: string;
	value: number;
	raw?: string;
}

export type ClassifiedMeasurementName =
	| { kind: "ordinary"; name: string; normalizedName: string }
	| { kind: "parameter"; name: string; paramName: string; normalizedParamName: string }
	| { kind: "worst-case-min"; name: string; paramName: string; normalizedParamName: string }
	| { kind: "worst-case-max"; name: string; paramName: string; normalizedParamName: string }
	| { kind: "phase"; name: string; phaseName: string; normalizedPhaseName: string }
	| { kind: "spec-min"; name: string; measurementId: string; normalizedMeasurementId: string }
	| { kind: "spec-max"; name: string; measurementId: string; normalizedMeasurementId: string }
	| { kind: "invalid-reserved"; name: string; reason: string };

export interface DecodedReservedMeasurements<TMeasurement extends MeasurementValue = MeasurementValue> {
	ordinary: TMeasurement[];
	parameters: Map<string, { paramName: string; measurement: TMeasurement }>;
	worstCaseMin: Map<string, { paramName: string; measurement: TMeasurement }>;
	worstCaseMax: Map<string, { paramName: string; measurement: TMeasurement }>;
	phase: Map<string, { phaseName: string; measurement: TMeasurement }>;
	specMin: Map<string, { measurementId: string; measurement: TMeasurement }>;
	specMax: Map<string, { measurementId: string; measurement: TMeasurement }>;
	errors: string[];
}

const RESERVED_PATTERNS = [
	{ prefix: "__JLC_PARAM_", kind: "parameter" },
	{ prefix: "__JLC_WC_MIN_", kind: "worst-case-min" },
	{ prefix: "__JLC_WC_MAX_", kind: "worst-case-max" },
	{ prefix: "__JLC_PHASE_", kind: "phase" },
	{ prefix: "__JLC_SPEC_MIN_", kind: "spec-min" },
	{ prefix: "__JLC_SPEC_MAX_", kind: "spec-max" },
] as const;

const RESERVED_SUFFIX = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function classifyMeasurementName(name: string): ClassifiedMeasurementName {
	const trimmed = name.trim();
	const normalizedName = normalizeMeasurementId(trimmed);
	if (!normalizedName.startsWith(RESERVED_MEASUREMENT_PREFIX.toLowerCase())) {
		return { kind: "ordinary", name: trimmed, normalizedName };
	}

	for (const pattern of RESERVED_PATTERNS) {
		if (!normalizedName.startsWith(pattern.prefix.toLowerCase())) continue;
		const suffix = trimmed.slice(pattern.prefix.length);
		if (!RESERVED_SUFFIX.test(suffix)) {
			return {
				kind: "invalid-reserved",
				name: trimmed,
				reason: `Reserved measurement ${trimmed} has an invalid suffix`,
			};
		}
		if (pattern.kind === "phase") {
			return {
				kind: pattern.kind,
				name: trimmed,
				phaseName: suffix,
				normalizedPhaseName: normalizeMeasurementId(suffix),
			};
		}
		if (pattern.kind === "parameter" || pattern.kind === "worst-case-min" || pattern.kind === "worst-case-max") {
			return {
				kind: pattern.kind,
				name: trimmed,
				paramName: suffix,
				normalizedParamName: normalizeMeasurementId(suffix),
			};
		}
		return {
			kind: pattern.kind,
			name: trimmed,
			measurementId: suffix,
			normalizedMeasurementId: normalizeMeasurementId(suffix),
		};
	}

	return {
		kind: "invalid-reserved",
		name: trimmed,
		reason: `Unknown reserved measurement name: ${trimmed}`,
	};
}

export function decodeReservedMeasurements<TMeasurement extends MeasurementValue>(
	measurements: TMeasurement[],
): DecodedReservedMeasurements<TMeasurement> {
	const decoded: DecodedReservedMeasurements<TMeasurement> = {
		ordinary: [],
		parameters: new Map(),
		worstCaseMin: new Map(),
		worstCaseMax: new Map(),
		phase: new Map(),
		specMin: new Map(),
		specMax: new Map(),
		errors: [],
	};

	for (const measurement of measurements) {
		const classified = classifyMeasurementName(measurement.name);
		if (classified.kind === "ordinary") {
			decoded.ordinary.push(measurement);
			continue;
		}
		if (classified.kind === "invalid-reserved") {
			decoded.errors.push(classified.reason);
			continue;
		}
		if (!Number.isFinite(measurement.value)) {
			decoded.errors.push(`Measurement ${measurement.name} is not finite`);
			continue;
		}
		if (classified.kind === "parameter") {
			addUnique(
				decoded.parameters,
				classified.normalizedParamName,
				{ paramName: classified.paramName, measurement },
				measurement.name,
				decoded.errors,
			);
			continue;
		}
		if (classified.kind === "worst-case-min") {
			addUnique(
				decoded.worstCaseMin,
				classified.normalizedParamName,
				{ paramName: classified.paramName, measurement },
				measurement.name,
				decoded.errors,
			);
			continue;
		}
		if (classified.kind === "worst-case-max") {
			addUnique(
				decoded.worstCaseMax,
				classified.normalizedParamName,
				{ paramName: classified.paramName, measurement },
				measurement.name,
				decoded.errors,
			);
			continue;
		}
		if (classified.kind === "phase") {
			addUnique(
				decoded.phase,
				classified.normalizedPhaseName,
				{
					phaseName: classified.phaseName,
					// ngspice 的相位 .meas 返回弧度，统一在此换算为度，MC 与 WCA 共享。
					measurement: { ...measurement, value: measurement.value * RADIAN_TO_DEGREE },
				},
				measurement.name,
				decoded.errors,
			);
			continue;
		}
		if (classified.kind === "spec-min") {
			addUnique(
				decoded.specMin,
				classified.normalizedMeasurementId,
				{ measurementId: classified.measurementId, measurement },
				measurement.name,
				decoded.errors,
			);
			continue;
		}
		addUnique(
			decoded.specMax,
			classified.normalizedMeasurementId,
			{ measurementId: classified.measurementId, measurement },
			measurement.name,
			decoded.errors,
		);
	}

	return decoded;
}

export function normalizeMeasurementId(value: string): string {
	return value.trim().toLowerCase();
}

function addUnique<T>(
	target: Map<string, T>,
	key: string,
	value: T,
	name: string,
	errors: string[],
): void {
	if (target.has(key)) {
		errors.push(`Duplicate reserved measurement: ${name}`);
		return;
	}
	target.set(key, value);
}
