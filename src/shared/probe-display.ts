import type { ProbeTarget } from "./probe";

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

/** 画布/CSV 用：把曲线名里的节点名替换成探针位号，无位号时原样返回。 */
export function traceDisplayName(traceName: string, probeNames: Map<string, string>): string {
	const wrapped = /^([vi])\((.*?)\)(.*)$/i.exec(traceName.trim());
	if (wrapped) {
		const probe = probeNames.get(wrapped[2].trim().toLowerCase());
		return probe ? `${wrapped[1].toUpperCase()}(${probe})${wrapped[3]}` : traceName;
	}
	const digital = /^(.*?)\s+digital$/i.exec(traceName.trim());
	if (digital) {
		const probe = probeNames.get(digital[1].trim().toLowerCase());
		return probe ? `${probe} digital` : traceName;
	}
	return traceName;
}

/** 曲线弹窗用：节点名后附加探针位号，无位号时原样返回。 */
export function dialogTraceLabel(traceName: string, probeNames: Map<string, string>): string {
	const wrapped = /^([vi])\((.*?)\)(.*)$/i.exec(traceName.trim());
	if (wrapped) {
		const probe = probeNames.get(wrapped[2].trim().toLowerCase());
		return probe ? `${traceName} · ${probe}` : traceName;
	}
	const digital = /^(.*?)\s+digital$/i.exec(traceName.trim());
	if (digital) {
		const probe = probeNames.get(digital[1].trim().toLowerCase());
		return probe ? `${traceName} · ${probe}` : traceName;
	}
	return traceName;
}
