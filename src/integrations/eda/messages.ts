import type { SpiceCommandType } from "../../shared/analysis-types";
import {
	parseProbeDescriptors,
	type ProbeDescriptor,
} from "./protocol/probe";

export const NETLIST_TOPIC = "jlc-ngspice-waveform:netlist";
export const REQUEST_NETLIST_TOPIC = "jlc-ngspice-waveform:request-netlist";
export const EDA_NETLIST_PROTOCOL_VERSION = 3 as const;

export interface StandardAnalysisPayload {
	/** 必填。产品分析类型，必须与网表中唯一的原生分析指令一致。 */
	type: SpiceCommandType;
}

export interface MonteCarloPayload {
	/** 必填。选择 Monte Carlo 产品分析流程。 */
	type: "monte-carlo";
	/** 必填。表示样本数量的正安全整数。 */
	sampleCount: number;
	/** 可选。用于复现相同随机序列的 ngspice 正整数种子。 */
	seed?: number;
}

export interface WorstCasePayload {
	/** 必填。选择 Worst Case 产品分析流程。 */
	type: "worst-case";
	/** 必填。引用网表中一个普通的、非保留名称的 .meas 结果。 */
	objective: {
		/** 必填。不区分大小写的 .meas 名称，用于确定参数的低侧和高侧方向。 */
		measurementId: string;
		/** 可选。展示名称；省略时使用 measurementId。 */
		label?: string;
		/** 可选。展示和导出单位，不影响 ngspice 计算。 */
		unit?: string;
	};
}

export type AnalysisPayload =
	| StandardAnalysisPayload
	| MonteCarloPayload
	| WorstCasePayload;

export interface NetlistImportMessage {
	/** 必填。必须为 3；不兼容的请求结构会被拒绝。 */
	protocolVersion: typeof EDA_NETLIST_PROTOCOL_VERSION;
	/** 必填。完整且自包含的 ngspice 网表，不包含 .control 块。 */
	netlist: string;
	/** 外部可省略。解析器会将缺省值规范化为 simulation-netlist.cir。 */
	fileName: string;
	/** 必填。决定产品分析流程及其最小运行参数。 */
	analysis: AnalysisPayload;
	/** 外部可省略。只控制初始可见曲线，不限制 ngspice 采集的节点。 */
	defaultVisibleProbes: ProbeDescriptor[];
	/** 可选。ngspice 兼容网表（ngbehavior 标志），如 "ps"、"psa"、"ltpsa"、"hs"、"spe"、"ki"、"s3"、"eg"。
	 * 缺省或空字符串 = 不兼容（默认 Spice3 行为）。仅允许字母。 */
	compatMode?: string;
}

/** 传入网表前置处理 */
export function parseNetlistImportMessage(value: unknown): NetlistImportMessage | null {
	if (!isRecord(value) || value.protocolVersion !== EDA_NETLIST_PROTOCOL_VERSION) return null;
	if (typeof value.netlist !== "string" || !value.netlist.trim()) return null;
	const fileName = value.fileName === undefined ? "simulation-netlist.cir" : readString(value.fileName);
	const analysis = parseAnalysisPayload(value.analysis);
	const defaultVisibleProbes = parseProbeDescriptors(value.defaultVisibleProbes);
	const compatMode = parseCompatMode(value.compatMode);
	if (!fileName || !analysis || !defaultVisibleProbes || compatMode === null) return null;
	return {
		protocolVersion: value.protocolVersion,
		netlist: value.netlist,
		fileName,
		analysis,
		defaultVisibleProbes,
		...(compatMode ? { compatMode } : {}),
	};
}

/** 解析可选兼容网表。缺省/空 -> undefined；非字母或非法字符 -> null（协议错误）。 */
function parseCompatMode(value: unknown): string | null | undefined {
	if (value === undefined || value === null) return undefined;
	const raw = readString(value);
	if (!raw) return undefined;
	if (!/^[A-Za-z]+$/.test(raw)) return null;
	return raw;
}

function parseAnalysisPayload(value: unknown): AnalysisPayload | null {
	if (!isRecord(value)) return null;
	if (value.type === "transient" || value.type === "ac" || value.type === "dc") {
		return { type: value.type };
	}
	if (value.type === "monte-carlo") {
		const sampleCount = readFiniteNumber(value.sampleCount);
		const seed = value.seed === undefined ? undefined : readFiniteNumber(value.seed);
		if (
			sampleCount === null
			|| !Number.isSafeInteger(sampleCount)
			|| sampleCount <= 0
			|| (value.seed !== undefined
				&& (seed === null || seed === undefined || !Number.isSafeInteger(seed) || seed <= 0 || seed > 2_147_483_646))
		) return null;
		return {
			type: value.type,
			sampleCount,
			...(seed === undefined || seed === null ? {} : { seed }),
		};
	}
	if (value.type === "worst-case") {
		if (!isRecord(value.objective)) return null;
		const measurementId = readString(value.objective.measurementId);
		const label = readOptionalString(value.objective.label);
		const unit = readOptionalString(value.objective.unit);
		if (!measurementId || label === null || unit === null) return null;
		return {
			type: value.type,
			objective: {
				measurementId,
				...(label ? { label } : {}),
				...(unit ? { unit } : {}),
			},
		};
	}
	return null;
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
