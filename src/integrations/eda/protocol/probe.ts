import type { ProbeTarget } from "../../../shared/probe";

export interface ProbeDescriptor {
	kind: "analog-voltage" | "digital";
	node: string;
	lowLevel?: number;
	highLevel?: number;
}

export function parseProbeDescriptors(value: unknown): ProbeDescriptor[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const probes: ProbeDescriptor[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!isRecord(item)) continue;
		const node = readNode(item.node);
		const lowLevel = readOptionalFiniteNumber(item.lowLevel);
		const highLevel = readOptionalFiniteNumber(item.highLevel);
		// 单个探针字段非法只跳过该探针，不再作废整份列表：
		// EDA 可能注入个别不合规探针（如 lowLevel === highLevel），不应拖垮全部提取。
		if (
			!node
			|| (item.kind !== "analog-voltage" && item.kind !== "digital")
			|| lowLevel === null
			|| highLevel === null
		) continue;
		if (item.kind === "analog-voltage" && (lowLevel !== undefined || highLevel !== undefined)) continue;
		if (item.kind === "digital") {
			if ((lowLevel === undefined) !== (highLevel === undefined)) continue;
			// lowLevel === highLevel 合法（无 U 带）；仅真正反转（low > high）才跳过。
			if (lowLevel !== undefined && highLevel !== undefined && lowLevel > highLevel) continue;
		}
		const probe: ProbeDescriptor = {
			kind: item.kind,
			node,
			...(lowLevel === undefined ? {} : { lowLevel }),
			...(highLevel === undefined ? {} : { highLevel }),
		};
		const key = `${probe.kind}:${node.toLowerCase()}:${lowLevel ?? ""}:${highLevel ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		probes.push(probe);
	}
	return probes;
}

export function probeDescriptorsToTargets(probes: ProbeDescriptor[]): ProbeTarget[] {
	return probes.map((probe) => ({
		node: probe.node,
		...(probe.kind === "digital" ? { probeType: 1 } : {}),
		...(probe.lowLevel === undefined ? {} : { lowLevel: probe.lowLevel }),
		...(probe.highLevel === undefined ? {} : { highLevel: probe.highLevel }),
	}));
}

/** 将历史 EasyEDA 探针字段名转换为当前规范结构。 */
export function parseLegacyProbeDescriptors(value: unknown): ProbeDescriptor[] | null {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return null;
	const probes: ProbeDescriptor[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!isRecord(item)) continue;
		const node = readNode(item.node ?? item.probeNode ?? item.ProbeNode ?? item.id);
		const probeType = readOptionalFiniteNumber(item.probeType ?? item.ProbeType);
		const lowLevel = readOptionalFiniteNumber(item.lowLevel ?? item.LowLevel);
		const highLevel = readOptionalFiniteNumber(item.highLevel ?? item.hightLevel ?? item.HighLevel ?? item.HightLevel);
		// 与 parseProbeDescriptors 一致：单个探针非法只跳过，不作废整份列表。
		if (!node || probeType === null || lowLevel === null || highLevel === null) continue;
		// 数字探针阈值反转（low > high）才跳过；等值合法（无 U 带）。
		if (probeType === 1 && lowLevel !== undefined && highLevel !== undefined && lowLevel > highLevel) continue;
		const kind = probeType === 1 ? "digital" : "analog-voltage";
		const probe: ProbeDescriptor = {
			kind,
			node,
			...(kind === "digital" && lowLevel !== undefined ? { lowLevel } : {}),
			...(kind === "digital" && highLevel !== undefined ? { highLevel } : {}),
		};
		const key = `${kind}:${node.toLowerCase()}:${probe.lowLevel ?? ""}:${probe.highLevel ?? ""}`;
		if (seen.has(key)) continue;
		seen.add(key);
		probes.push(probe);
	}
	return probes;
}

function readNode(value: unknown): string {
	return typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
}

function readOptionalFiniteNumber(value: unknown): number | undefined | null {
	if (value === undefined || value === null || value === "") return undefined;
	const number = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() ? Number(value.trim()) : Number.NaN;
	return Number.isFinite(number) ? number : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
