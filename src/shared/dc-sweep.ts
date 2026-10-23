import { findAnalysisDirectives } from "./netlist";

/** DC 扫描源的类别：电压源 / 电流源 / 其它（电阻、温度等，不在本需求范围）。 */
export type DcSweepSourceKind = "voltage" | "current" | "other";

/** 从 .dc 指令解析出的单个扫描源参数。 */
export interface DcSweepSourceSpec {
	name: string;
	kind: DcSweepSourceKind;
	start: number;
	stop: number;
	step: number;
	/** 理论扫描点数：floor((stop-start)/step)+1，与 ngspice dctrcurv 的循环语义一致。 */
	count: number;
}

export interface DcSweepPlan {
	source1: DcSweepSourceSpec;
	source2: DcSweepSourceSpec | null;
	/** 内层（源1）每组的点数。 */
	innerCount: number;
	/** 外层（源2）的组数；单源时为 1。 */
	groupCount: number;
}

/** 随波形数据冻结的 DC 扫描元信息（展示层据此生成本次结果的标题/分组）。 */
export interface DcSweepSourceInfo {
	name: string;
	kind: DcSweepSourceKind;
	unit: string;
}

export interface DcSweepMeta {
	source1: DcSweepSourceInfo;
	source2: DcSweepSourceInfo | null;
	innerCount: number;
	groupCount: number;
	/** false = 双源分组无法确定（点数对不上或解析失败），展示层提示解析失败。 */
	groupingOk: boolean;
	/** true = 数据中存在无效点（缺口），渲染断线并提示结果不完整。 */
	incomplete: boolean;
}

export interface DcSweepParseResult {
	plan: DcSweepPlan | null;
	/** true = 网表试图配置双源扫描，但第二个扫描源参数无法解析。 */
	source2Unparsable?: boolean;
}

const MAX_SWEEP_POINTS = 1_000_000;

/**
 * 解析网表中的 .dc 指令（要求全网表恰有一条）：
 *   .dc <源1> <起始> <终止> <步进> [<源2> <起始> <终止> <步进>]
 * 源1 是内层扫描（决定横轴），源2 是外层扫描（决定分组），与 ngspice 语义一致。
 * 仅支持线性四元组形式；PSpice 的 LIN/OCT/DEC/LIST 变体按解析失败处理。
 */
export function parseDcSweepDirective(netlist: string): DcSweepParseResult {
	const directives = findAnalysisDirectives(netlist).filter((directive) => directive.type === "dc");
	if (directives.length !== 1) return { plan: null };
	const tokens = directives[0].command.trim().split(/\s+/).slice(1).filter(Boolean);
	if (tokens.length !== 4 && tokens.length !== 8) return { plan: null };

	const source1 = parseSweepSource(tokens.slice(0, 4));
	if (!source1) {
		return tokens.length === 8 ? { plan: null, source2Unparsable: true } : { plan: null };
	}
	if (tokens.length === 4) {
		return {
			plan: { source1, source2: null, innerCount: source1.count, groupCount: 1 },
		};
	}
	const source2 = parseSweepSource(tokens.slice(4, 8));
	if (!source2) return { plan: null, source2Unparsable: true };
	return {
		plan: {
			source1,
			source2,
			innerCount: source1.count,
			groupCount: source2.count,
		},
	};
}

function parseSweepSource(tokens: string[]): DcSweepSourceSpec | null {
	const [name, startToken, stopToken, stepToken] = tokens;
	if (!name || !startToken || !stopToken || !stepToken) return null;
	const start = parseSpiceNumber(startToken);
	const stop = parseSpiceNumber(stopToken);
	const step = parseSpiceNumber(stepToken);
	if (start === null || stop === null || step === null) return null;
	const count = expectedSweepPointCount(start, stop, step);
	if (count < 1 || count > MAX_SWEEP_POINTS) return null;
	return { name, kind: dcSourceKind(name), start, stop, step, count };
}

/**
 * 理论扫描点数
 */
export function expectedSweepPointCount(start: number, stop: number, step: number): number {
	if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step) || step === 0) return 0;
	const count = Math.floor((stop - start) / step + 1e-9) + 1;
	return Number.isSafeInteger(count) && count >= 1 ? count : 0;
}

/** 按位号首字母判别源类型：I* 为电流源，V* 为电压源，其余（R/温度等）归为 other。 */
export function dcSourceKind(name: string): DcSweepSourceKind {
	if (/^i/i.test(name)) return "current";
	if (/^v/i.test(name)) return "voltage";
	return "other";
}

export function unitForSourceKind(kind: DcSweepSourceKind): string {
	if (kind === "current") return "A";
	if (kind === "voltage") return "V";
	return "";
}

/** ngspice 横轴向量名 → 源类别。 */
export function dcSourceKindFromScaleName(scaleName: string): DcSweepSourceKind {
	if (/^i-sweep$/i.test(scaleName)) return "current";
	if (/^v-sweep$/i.test(scaleName)) return "voltage";
	return "other";
}

/** ngspice 横轴向量名 → 轴单位。 */
export function dcUnitFromScaleName(scaleName: string): string {
	if (/^i-sweep$/i.test(scaleName)) return "A";
	if (/^temp-sweep$/i.test(scaleName)) return "°C";
	return "V";
}

const SPICE_PLAIN_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPICE_SUFFIX_NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(meg|[tgkmunpf])$/i;
const SPICE_SUFFIX_FACTORS: Record<string, number> = {
	t: 1e12,
	g: 1e9,
	k: 1e3,
	m: 1e-3,
	u: 1e-6,
	n: 1e-9,
	p: 1e-12,
	f: 1e-15,
};

/** 解析 SPICE 工程前缀数值："1m"→0.001、"100u"→1e-4、"1Meg"→1e6（大小写不敏感，M=m）。 */
export function parseSpiceNumber(token: string): number | null {
	const text = token.trim();
	if (!text) return null;
	if (SPICE_PLAIN_NUMBER.test(text)) {
		const value = Number(text);
		return Number.isFinite(value) ? value : null;
	}
	const match = SPICE_SUFFIX_NUMBER.exec(text);
	if (!match) return null;
	const mantissa = Number(match[1]);
	if (!Number.isFinite(mantissa)) return null;
	const suffix = match[2].toLowerCase();
	const factor = suffix === "meg" ? 1e6 : SPICE_SUFFIX_FACTORS[suffix];
	// 15 位有效数字规整。
	const value = Number((mantissa * factor).toPrecision(15));
	return Number.isFinite(value) ? value : null;
}

const ENGINEERING_LADDERS: Record<string, Array<[number, string]>> = {
	V: [[1e3, "kV"], [1, "V"], [1e-3, "mV"], [1e-6, "uV"], [1e-9, "nV"]],
	A: [[1, "A"], [1e-3, "mA"], [1e-6, "uA"], [1e-9, "nA"]],
};

/** 分组图例用的工程前缀数值："1 V"、"2 V"、"1 mA"、"500 uA"。 */
export function formatEngineeringValue(value: number, unit: string): string {
	if (!Number.isFinite(value)) return `${value}${unit ? ` ${unit}` : ""}`;
	const ladder = ENGINEERING_LADDERS[unit];
	if (!ladder) return `${formatEngineeringMantissa(value)}${unit ? ` ${unit}` : ""}`;
	if (value === 0) {
		const base = ladder.find(([, label]) => label === unit) ?? ladder[0];
		return `0 ${base[1]}`;
	}
	const abs = Math.abs(value);
	const selected = ladder.find(([factor]) => abs >= factor) ?? ladder[ladder.length - 1];
	return `${formatEngineeringMantissa(value / selected[0])} ${selected[1]}`;
}

function formatEngineeringMantissa(value: number): string {
	return String(Number(value.toPrecision(6)));
}
