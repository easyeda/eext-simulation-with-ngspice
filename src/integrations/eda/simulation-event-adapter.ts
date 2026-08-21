import type { AnalysisType } from "../../shared/analysis-types";
import { findAnalysisDirectives } from "../../shared/netlist";
import {
	EDA_NETLIST_PROTOCOL_VERSION,
	parseNetlistImportMessage,
	type AnalysisPayload,
	type NetlistImportMessage,
} from "./messages";
import { parseLegacyProbeDescriptors } from "./protocol/probe";

export type SimulationEventAdaptResult =
	| { ok: true; message: NetlistImportMessage }
	| { ok: false; error: string };

/** 将历史 EasyEDA 字段别名转换为规范的 v3 请求。 */
export function adaptSimulationEvent(props: unknown): SimulationEventAdaptResult {
	const direct = parseNetlistImportMessage(props);
	if (direct) return { ok: true, message: direct };

	const record = isRecord(props) ? props : {};
	const netlist = typeof record.netlist === "string" ? record.netlist : "";
	if (!netlist.trim()) return { ok: false, error: "empty netlist" };
	const directives = findAnalysisDirectives(netlist);
	if (directives.length !== 1) {
		return {
			ok: false,
			error: directives.length
				? "multiple .tran, .ac, or .dc commands"
				: "no supported .tran, .ac, or .dc command",
		};
	}

	const defaultVisibleProbes = parseLegacyProbeDescriptors(
		record.probeNodes ?? record.ProbeNodes,
	);
	if (!defaultVisibleProbes) return { ok: false, error: "probeNodes are invalid" };

	const analysisType = adaptAnalysisType(record) ?? directives[0].type;
	const analysis = adaptAnalysisPayload(record, analysisType);
	if (!analysis) return { ok: false, error: `${analysisType} options are missing or invalid` };

	const compatMode = readString(firstDefined(
		record.compatMode,
		record.CompatMode,
		record.compatibilityMode,
		record.ngbehavior,
		record.NgBehavior,
	)) || undefined;
	const candidate = {
		protocolVersion: EDA_NETLIST_PROTOCOL_VERSION,
		fileName: readString(record.fileName) || "simulation-netlist.cir",
		netlist,
		analysis,
		defaultVisibleProbes,
		...(compatMode ? { compatMode } : {}),
	};
	const message = parseNetlistImportMessage(candidate);
	return message ? { ok: true, message } : { ok: false, error: "normalized v3 request is invalid" };
}

function adaptAnalysisPayload(
	record: Record<string, unknown>,
	analysisType: AnalysisType,
): AnalysisPayload | null {
	if (analysisType === "transient" || analysisType === "ac" || analysisType === "dc") {
		return { type: analysisType };
	}
	if (analysisType === "monte-carlo") {
		const source = firstRecord(record.monteCarlo, record.MonteCarlo, record.mc, record.MC) ?? record;
		const sampleCount = readFiniteNumber(
			firstDefined(source.sampleCount, source.samples, source.runs, source.runCount, source.count),
		);
		const rawSeed = firstDefined(source.seed, source.randomSeed);
		const seed = rawSeed === undefined ? undefined : readFiniteNumber(rawSeed);
		if (
			sampleCount === null
			|| !Number.isSafeInteger(sampleCount)
			|| sampleCount <= 0
			|| (rawSeed !== undefined
				&& (seed === null || seed === undefined || !Number.isSafeInteger(seed) || seed <= 0 || seed > 2_147_483_646))
		) return null;
		return {
			type: analysisType,
			sampleCount,
			...(seed === undefined || seed === null ? {} : { seed }),
		};
	}

	const source = firstRecord(record.worstCase, record.WorstCase, record.wca, record.WCA) ?? record;
	const objectiveSource = firstRecord(source.objective, source.Objective);
	if (!objectiveSource) return null;
	const measurementId = readString(objectiveSource.measurementId ?? objectiveSource.id ?? objectiveSource.name);
	const label = readOptionalString(objectiveSource.label);
	const unit = readOptionalString(objectiveSource.unit);
	if (!measurementId || label === null || unit === null) return null;
	return {
		type: analysisType,
		objective: {
			measurementId,
			...(label ? { label } : {}),
			...(unit ? { unit } : {}),
		},
	};
}

function adaptAnalysisType(record: Record<string, unknown>): AnalysisType | null {
	const raw = String(record.analysisType ?? record.simulationMode ?? record.mode ?? "").trim().toLowerCase();
	if (raw === "tran" || raw === "transient") return "transient";
	if (raw === "ac") return "ac";
	if (raw === "dc") return "dc";
	if (raw === "monte-carlo" || raw === "montecarlo" || raw === "mc") return "monte-carlo";
	if (raw === "worst-case" || raw === "worstcase" || raw === "wca") return "worst-case";
	if (firstRecord(record.worstCase, record.WorstCase, record.wca, record.WCA)) return "worst-case";
	if (firstRecord(record.monteCarlo, record.MonteCarlo, record.mc, record.MC)) return "monte-carlo";
	return null;
}

function firstRecord(...values: unknown[]): Record<string, unknown> | null {
	for (const value of values) if (isRecord(value)) return value;
	return null;
}

function firstDefined(...values: unknown[]): unknown {
	return values.find((value) => value !== undefined && value !== null && value !== "");
}

function readFiniteNumber(value: unknown): number | null {
	const number = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
	return Number.isFinite(number) ? number : null;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function readOptionalString(value: unknown): string | null {
	return value === undefined ? "" : typeof value === "string" ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
