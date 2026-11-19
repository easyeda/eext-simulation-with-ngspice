import { findAnalysisDirectives, stripComments } from "../../shared/netlist";
import { extractCurrentProbes, type CurrentProbe } from "../../shared/probe-discovery";
import type { WorstCaseObjective } from "./types";

/** 电流目标合成信息：注入 A/B 两条普通测量，解码后 (A-B)/电阻 合成目标值。 */
export interface CurrentProbeSynthesis {
	/** 目标测量名（如 PRI1），本身不在网表中，由解码层合成。 */
	id: string;
	nameA: string;
	nameB: string;
	nodeA: string;
	nodeB: string;
	resistance: number;
}

export interface PreparedWorstCaseObjective {
	netlist: string;
	objective: WorstCaseObjective;
	logs: string[];
	/** 非空 = 已注入 A/B 电压测量；目标值在解码层合成，无需 save all。 */
	synthesis: CurrentProbeSynthesis | null;
}

/**
 * 电流探针目标兜底：EDA 约定 PRI 探针不在网表生成 .meas，当 objective 在网表里
 * 找不到对应测量且能匹配 XAM 电流探针时，注入两条端点电压的普通 FIND 测量
 * （端点属主电路节点，默认选择性保存已覆盖），解码后按 (A-B)/电阻 合成目标值。
 * 不用 par() 表达式——它在选择性保存下无法求值，会逼出 save all。
 */
export function prepareWorstCaseObjective(
	netlist: string,
	objective: WorstCaseObjective,
): PreparedWorstCaseObjective {
	const logs: string[] = [];
	const id = objective?.measurementId?.trim() ?? "";
	if (!id || hasMeasEntry(netlist, id)) return { netlist, objective, logs, synthesis: null };
	const probe = matchCurrentProbe(netlist, id);
	if (!probe) return { netlist, objective, logs, synthesis: null };
	const stop = transientStopValue(netlist);
	if (stop === null) {
		logs.push(`warning: current probe objective ${id} needs a .tran stop time to synthesize measurements, none found`);
		return { netlist, objective, logs, synthesis: null };
	}
	const nameA = `${id}_A`;
	const nameB = `${id}_B`;
	if (hasMeasEntry(netlist, nameA) || hasMeasEntry(netlist, nameB)) {
		return { netlist, objective, logs, synthesis: null };
	}
	const synthesis: CurrentProbeSynthesis = {
		id,
		nameA,
		nameB,
		nodeA: probe.nodeA,
		nodeB: probe.nodeB,
		resistance: probe.resistance,
	};
	const measA = `.meas tran ${nameA} FIND v(${probe.nodeA}) AT=${stop}`;
	const measB = `.meas tran ${nameB} FIND v(${probe.nodeB}) AT=${stop}`;
	logs.push(`Current probe objective ${id} synthesized: ${measA} + ${measB}`);
	return {
		netlist: insertBeforeEnd(netlist, `${measA}\n${measB}`),
		objective: objective.unit ? objective : { ...objective, unit: "A" },
		logs,
		synthesis,
	};
}

/** 网表里已存在同名 .meas（不限分析类型）时跳过兜底。 */
function hasMeasEntry(netlist: string, id: string): boolean {
	const escaped = id.replace(/[.*+?${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^\\s*\\.meas(?:ure)?\\s+\\S+\\s+${escaped}\\b`, "im").test(stripComments(netlist));
}

/** 位号匹配：XAMPRI1 → PRI1；objective 也允许带 i() 包装。 */
function matchCurrentProbe(netlist: string, id: string): CurrentProbe | null {
	const wanted = id.replace(/^i\(/i, "").replace(/\)$/, "").toLowerCase();
	return extractCurrentProbes(netlist).find((probe) => {
		const device = probe.name.replace(/^i\(/i, "").replace(/\)$/, "");
		return device === wanted || device.replace(/^xam/i, "") === wanted;
	}) || null;
}

/** 瞬态停止时间（.tran 的第二个时间参数）原样返回，供 AT= 使用。 */
function transientStopValue(netlist: string): string | null {
	const directives = findAnalysisDirectives(netlist);
	if (directives.length !== 1 || directives[0].type !== "transient") return null;
	const tokens = directives[0].command.split(/\s+/);
	return tokens.length >= 3 && /^[\d.]/.test(tokens[2]) ? tokens[2] : null;
}

/** 插到顶层 .end 之前（.ends 不受影响）；没有 .end 时追加到末尾。 */
function insertBeforeEnd(netlist: string, measLines: string): string {
	const lines = netlist.split(/\r?\n/);
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (/^\s*\.end\s*$/i.test(lines[index])) {
			lines.splice(index, 0, measLines);
			return lines.join("\n");
		}
	}
	return `${netlist.replace(/\s*$/, "")}\n${measLines}\n`;
}
