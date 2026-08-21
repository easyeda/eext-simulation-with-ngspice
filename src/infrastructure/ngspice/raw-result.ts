import type {
	SpiceEventNode,
	SpiceMeasurement,
	SpiceNativeResult,
	SpicePlotSnapshot,
	SpiceScalar,
	SpiceVectorSnapshot,
} from "../../core/simulation/spice-engine";

export const NGSPICE_RESULT_PROTOCOL_VERSION = 2 as const;

export type NgspiceScalar = SpiceScalar;

export interface NgspiceRawVector extends SpiceVectorSnapshot {}

export interface NgspiceRawPlot extends SpicePlotSnapshot {
	vectors: NgspiceRawVector[];
}

export interface NgspiceRawMeasurement extends SpiceMeasurement {}

export interface NgspiceRawEventPoint {
	step: number;
	dcop: number;
	value: string;
}

export interface NgspiceRawEventNode extends SpiceEventNode {
	points: NgspiceRawEventPoint[];
}

export interface NgspiceDiagnostics {
	errors: string[];
	warnings: string[];
}

export interface NgspiceRawResult extends SpiceNativeResult {
	protocolVersion: typeof NGSPICE_RESULT_PROTOCOL_VERSION;
	plots: NgspiceRawPlot[];
	events: NgspiceRawEventNode[];
	measurements: NgspiceRawMeasurement[];
	diagnostics: NgspiceDiagnostics;
}

export function parseNgspiceRawResult(json: string): NgspiceRawResult {
	let value: unknown;
	try {
		value = JSON.parse(json);
	}
	catch (error) {
		throw new Error(`Invalid ngspice result JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!isRecord(value)) throw new Error("ngspice result must be a JSON object");
	if (value.protocolVersion !== NGSPICE_RESULT_PROTOCOL_VERSION) {
		throw new Error(`Unsupported ngspice result protocol: ${String(value.protocolVersion)}`);
	}
	if (!Array.isArray(value.plots)) throw new Error("ngspice result plots must be an array");

	return {
		protocolVersion: NGSPICE_RESULT_PROTOCOL_VERSION,
		currentPlot: typeof value.currentPlot === "string" && value.currentPlot.trim() ? value.currentPlot : null,
		plots: value.plots.map(parsePlot),
		events: parseEvents(value.events),
		measurements: parseMeasurements(value.measurements),
		diagnostics: parseDiagnostics(value.diagnostics),
	};
}

function parseEvents(value: unknown): NgspiceRawEventNode[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("ngspice result events must be an array");
	return value.map((item, index) => {
		if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) {
			throw new Error(`ngspice event node ${index} has no name`);
		}
		if (!Array.isArray(item.points)) throw new Error(`ngspice event node ${item.name} points must be an array`);
		return {
			name: item.name,
			points: item.points.map((point, pointIndex) => {
				if (!isRecord(point) || typeof point.step !== "number" || !Number.isFinite(point.step)) {
					throw new Error(`ngspice event ${item.name}[${pointIndex}] has an invalid step`);
				}
				return {
					step: point.step,
					dcop: finiteInteger(point.dcop),
					value: typeof point.value === "string" ? point.value : String(point.value ?? ""),
				};
			}),
		};
	});
}

function parsePlot(value: unknown, index: number): NgspiceRawPlot {
	if (!isRecord(value)) throw new Error(`ngspice plot ${index} must be an object`);
	if (typeof value.name !== "string" || !value.name.trim()) throw new Error(`ngspice plot ${index} has no name`);
	if (!Array.isArray(value.vectors)) throw new Error(`ngspice plot ${value.name} vectors must be an array`);
	return {
		name: value.name,
		vectors: value.vectors.map((vector, vectorIndex) => parseVector(vector, value.name as string, vectorIndex)),
	};
}

function parseVector(value: unknown, plotName: string, index: number): NgspiceRawVector {
	if (!isRecord(value)) throw new Error(`ngspice vector ${plotName}[${index}] must be an object`);
	const name = typeof value.name === "string" ? value.name.trim() : "";
	if (!name) throw new Error(`ngspice vector ${plotName}[${index}] has no name`);
	const valueType = value.valueType === "complex" ? "complex" as const : value.valueType === "real" ? "real" as const : null;
	if (!valueType) throw new Error(`ngspice vector ${plotName}.${name} has an invalid valueType`);
	if (!Array.isArray(value.real)) throw new Error(`ngspice vector ${plotName}.${name} real data must be an array`);
	const real = value.real.map(parseScalar);
	const imag = valueType === "complex"
		? (Array.isArray(value.imag) ? value.imag.map(parseScalar) : null)
		: undefined;
	if (valueType === "complex" && !imag) throw new Error(`ngspice vector ${plotName}.${name} has no imaginary data`);
	if (imag && imag.length !== real.length) throw new Error(`ngspice vector ${plotName}.${name} has mismatched complex data`);
	return {
		name,
		qualifiedName: typeof value.qualifiedName === "string" && value.qualifiedName.trim()
			? value.qualifiedName
			: `${plotName}.${name}`,
		valueType,
		vectorType: finiteInteger(value.vectorType),
		vectorFlags: finiteInteger(value.vectorFlags),
		real,
		...(imag ? { imag } : {}),
	};
}

function parseMeasurements(value: unknown): NgspiceRawMeasurement[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error("ngspice result measurements must be an array");
	return value.map((item) => {
		if (!isRecord(item) || typeof item.name !== "string" || !item.name.trim()) {
			throw new Error("ngspice measurement has no name");
		}
		const numeric = typeof item.value === "number" ? item.value : Number(item.value);
		if (!Number.isFinite(numeric)) throw new Error(`ngspice measurement ${item.name} is not finite`);
		return {
			name: item.name,
			value: numeric,
			...(typeof item.raw === "string" ? { raw: item.raw } : {}),
		};
	});
}

function parseDiagnostics(value: unknown): NgspiceDiagnostics {
	if (value === undefined) return { errors: [], warnings: [] };
	if (!isRecord(value)) throw new Error("ngspice result diagnostics must be an object");
	return {
		errors: stringArray(value.errors),
		warnings: stringArray(value.warnings),
	};
}

function parseScalar(value: unknown): NgspiceScalar {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function finiteInteger(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map((item) => String(item)).filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
