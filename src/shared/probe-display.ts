import type { ProbeTarget } from "./probe";
import { probeNameCandidates } from "./probe-names";

/** 探针位号映射：节点名(小写) → 位号。 */
export function probeNameByNode(probeNodes: ProbeTarget[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const probe of probeNodes) {
		const name = probe.probeName?.trim();
		if (!name) continue;
		map.set(probe.node.trim().toLowerCase(), name);
	}
	return map;
}

/** XAM 电流探针曲线名（i(xamPRV1)）反推位号；非电流探针返回 null。 */
export function currentProbeRefdes(traceName: string): string | null {
	const match = /^i\(\s*xam([^)]+)\)/i.exec(traceName.trim());
	return match ? match[1].toUpperCase() : null;
}

/** 画布/CSV 用：把曲线名里的节点名替换成探针位号，无位号时原样返回。 */
export function traceDisplayName(traceName: string, probeNames: Map<string, string>): string {
	const wrapped = /^([vi])\((.*?)\)(.*)$/i.exec(traceName.trim());
	if (wrapped) {
		const probe = probeNames.get(wrapped[2].trim().toLowerCase()) ?? currentProbeRefdes(traceName);
		return probe ? `${wrapped[1].toUpperCase()}(${probe})${wrapped[3]}` : traceName;
	}
	const digital = /^(.*?)\s+digital$/i.exec(traceName.trim());
	if (digital) {
		const probe = probeNames.get(digital[1].trim().toLowerCase());
		return probe ? `${probe} digital` : traceName;
	}
	return traceName;
}

/**
 * 曲线是否对应当前选的输出变量（探针位号/节点名）。
 * 兼容 EDA 的测量名写法（MEAS_PRV1 → PRV1）和 XAM 电流探针（PRI1 → i(xampri1)）。
 */
export function traceMatchesOutputVariable(
	traceName: string,
	traceId: string,
	outputVariable: string,
	probeNodes: ProbeTarget[] = [],
): boolean {
	const stripped = outputVariable.trim().replace(/^meas[_-]/i, "");
	if (!stripped) return false;
	const key = stripped.toLowerCase();
	const wanted = new Set(probeNameCandidates(stripped));
	// 位号 → 节点名：EDA 探针里同时带位号和节点，用位号找到对应节点再匹配曲线。
	for (const probe of probeNodes) {
		const probeKey = (probe.probeName || "").trim().toLowerCase();
		if (probeKey !== key && probe.node.trim().toLowerCase() !== key) continue;
		for (const candidate of probeNameCandidates(probe.node)) wanted.add(candidate);
	}
	const candidates = [...probeNameCandidates(traceName), ...probeNameCandidates(traceId)];
	const refdes = currentProbeRefdes(traceName);
	if (refdes) candidates.push(refdes.toLowerCase());
	return candidates.some((candidate) => wanted.has(candidate));
}

/** 曲线弹窗用：节点名后附加探针位号，无位号时原样返回。 */
export function dialogTraceLabel(traceName: string, probeNames: Map<string, string>): string {
	const wrapped = /^([vi])\((.*?)\)(.*)$/i.exec(traceName.trim());
	if (wrapped) {
		const probe = probeNames.get(wrapped[2].trim().toLowerCase()) ?? currentProbeRefdes(traceName);
		return probe ? `${traceName} · ${probe}` : traceName;
	}
	const digital = /^(.*?)\s+digital$/i.exec(traceName.trim());
	if (digital) {
		const probe = probeNames.get(digital[1].trim().toLowerCase());
		return probe ? `${traceName} · ${probe}` : traceName;
	}
	return traceName;
}
