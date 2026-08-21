import type { ProbeTarget } from "./probe";
import {
	normalizeCurrentProbeName,
	normalizeProbeText,
} from "./probe-names";

export interface CurrentProbe {
	name: string;
	nodeA: string;
	nodeB: string;
	resistance: number;
}

interface MainCircuitNode {
	node: string;
	probeType?: number;
}

export function inferMainCircuitOutputProbes(
	netlist: string,
	defaultDisplayProbes: ProbeTarget[] = [],
): ProbeTarget[] {
	const defaultsByNode = new Map<string, ProbeTarget>();
	for (const probe of defaultDisplayProbes) {
		defaultsByNode.set(normalizeNodeKey(probe.node), probe);
	}

	const probes: ProbeTarget[] = [];
	const seen = new Map<string, ProbeTarget>();
	for (const inferred of extractMainCircuitNodes(netlist)) {
		const key = normalizeNodeKey(inferred.node);
		if (!key) continue;

		const existing = seen.get(key);
		const defaults = defaultsByNode.get(key);
		const probeType = defaults?.probeType ?? inferred.probeType;
		const lowLevel = defaults?.lowLevel;
		const highLevel = defaults?.highLevel;

		if (existing) {
			if (existing.probeType === undefined && probeType !== undefined) existing.probeType = probeType;
			if (existing.lowLevel === undefined && lowLevel !== undefined) existing.lowLevel = lowLevel;
			if (existing.highLevel === undefined && highLevel !== undefined) existing.highLevel = highLevel;
			continue;
		}

		const probe: ProbeTarget = { node: inferred.node };
		if (probeType !== undefined) probe.probeType = probeType;
		if (lowLevel !== undefined) probe.lowLevel = lowLevel;
		if (highLevel !== undefined) probe.highLevel = highLevel;
		seen.set(key, probe);
		probes.push(probe);
	}
	return probes;
}

export function extractCurrentProbes(netlist: string): CurrentProbe[] {
	const probes: CurrentProbe[] = [];
	for (const rawLine of circuitBodyLines(netlist)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("*") || !/^XAM/i.test(line)) continue;
		const tokens = line.split(/\s+/);
		if (tokens.length < 3) continue;
		const [name, nodeA, nodeB] = tokens;
		if (!nodeA || !nodeB || isGround(nodeA) || isGround(nodeB)) continue;
		probes.push({
			name: normalizeCurrentProbeName(name),
			nodeA,
			nodeB,
			resistance: 1e-3,
		});
	}
	return dedupeCurrentProbes(probes);
}

function extractMainCircuitNodes(netlist: string): MainCircuitNode[] {
	const subcktNames = collectSubcktNames(netlist);
	const nodes: MainCircuitNode[] = [];
	for (const line of mainCircuitLines(netlist)) {
		nodes.push(...nodesForMainCircuitLine(line, subcktNames));
	}
	return dedupeMainCircuitNodes(nodes);
}

function collectSubcktNames(netlist: string): Set<string> {
	const names = new Set<string>();
	for (const rawLine of circuitBodyLines(netlist)) {
		const line = stripInlineComment(rawLine).trim();
		const match = /^\.subckt\s+(\S+)/i.exec(line);
		if (match) names.add(normalizeProbeText(match[1]));
	}
	return names;
}

function mainCircuitLines(netlist: string): string[] {
	const lines: string[] = [];
	let subcktDepth = 0;
	let pending = "";

	const flush = () => {
		if (pending.trim()) lines.push(pending.trim());
		pending = "";
	};

	for (const rawLine of circuitBodyLines(netlist)) {
		const line = stripInlineComment(rawLine).trim();
		if (!line || line.startsWith("*")) continue;

		if (/^\.subckt\b/i.test(line)) {
			flush();
			subcktDepth += 1;
			continue;
		}
		if (/^\.ends\b/i.test(line)) {
			subcktDepth = Math.max(0, subcktDepth - 1);
			continue;
		}
		if (subcktDepth > 0) continue;

		if (/^\+/.test(line)) {
			if (pending) pending += ` ${line.replace(/^\+\s*/, "")}`;
			continue;
		}

		flush();
		pending = line;
	}

	flush();
	return lines;
}

/** SPICE 将第一物理行保留为电路标题，不参与元件和节点解析。 */
function circuitBodyLines(netlist: string): string[] {
	return netlist.split(/\r?\n/).slice(1);
}

function nodesForMainCircuitLine(line: string, subcktNames: Set<string>): MainCircuitNode[] {
	if (!line || line.startsWith(".") || line.startsWith("+")) return [];

	const tokens = line.split(/\s+/).filter(Boolean);
	if (tokens.length < 2) return [];

	const element = tokens[0].charAt(0).toUpperCase();
	let nodeTokens: string[] = [];

	switch (element) {
		case "R":
		case "C":
		case "L":
		case "V":
		case "I":
		case "D":
		case "B":
		case "F":
		case "H":
			nodeTokens = tokens.slice(1, 3);
			break;
		case "E":
		case "G":
		case "S":
		case "W":
		case "T":
		case "O":
			nodeTokens = tokens.slice(1, 5);
			break;
		case "Q":
			nodeTokens = tokens.slice(1, Math.min(tokens.length - 1, 5));
			break;
		case "J":
		case "Z":
			nodeTokens = tokens.slice(1, 4);
			break;
		case "M":
			nodeTokens = tokens.slice(1, 5);
			break;
		case "X":
			nodeTokens = subcktInstanceNodeTokens(tokens, subcktNames);
			break;
		case "A":
			return xspiceNodes(tokens);
		case "K":
			nodeTokens = [];
			break;
		default:
			nodeTokens = tokens.slice(1).filter(looksLikeFallbackNodeToken);
			break;
	}

	return nodeTokens
		.map((node) => normalizeMainCircuitNode(node))
		.filter(Boolean)
		.map((node) => ({ node }));
}

function subcktInstanceNodeTokens(tokens: string[], subcktNames: Set<string>): string[] {
	const args = tokens.slice(1);
	const paramIndex = args.findIndex(isParamToken);
	const prefix = paramIndex >= 0 ? args.slice(0, paramIndex) : args;
	if (prefix.length <= 1) return [];

	for (let index = prefix.length - 1; index >= 0; index -= 1) {
		if (subcktNames.has(normalizeProbeText(prefix[index]))) {
			return prefix.slice(0, index);
		}
	}
	return prefix.slice(0, -1);
}

function xspiceNodes(tokens: string[]): MainCircuitNode[] {
	const args = tokens.slice(1);
	const paramIndex = args.findIndex(isParamToken);
	const prefix = paramIndex >= 0 ? args.slice(0, paramIndex) : args;
	if (prefix.length <= 1) return [];
	const nodeTokens = prefix.slice(0, -1);
	const nodes: MainCircuitNode[] = [];
	let digitalGroup = false;

	for (const token of nodeTokens) {
		const startsDigitalGroup = token.startsWith("[") || token.includes("[");
		const endsDigitalGroup = token.endsWith("]") || token.includes("]");
		const isDigital = digitalGroup || startsDigitalGroup || endsDigitalGroup;
		const node = normalizeMainCircuitNode(token);
		if (node) nodes.push({ node, ...(isDigital ? { probeType: 1 } : {}) });
		if (startsDigitalGroup && !endsDigitalGroup) digitalGroup = true;
		if (endsDigitalGroup) digitalGroup = false;
	}

	return nodes;
}

function normalizeMainCircuitNode(token: string): string {
	const normalized = token
		.trim()
		.replace(/^[\[\{,]+/, "")
		.replace(/[\]\},]+$/, "")
		.replace(/^v\((.*)\)$/i, "$1")
		.trim();
	if (
		!normalized
		|| isGround(normalized)
		|| isParamToken(normalized)
		|| !looksLikeNodeToken(normalized)
	) return "";
	return normalized.toLowerCase();
}

function looksLikeFallbackNodeToken(token: string): boolean {
	if (!looksLikeNodeToken(token)) return false;
	if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+)?$/i.test(token)) return false;
	return true;
}

function looksLikeNodeToken(token: string): boolean {
	if (!token || token.includes("=")) return false;
	if (/^[+\-*/(){}'"]+$/.test(token)) return false;
	if (/^(dc|ac|pulse|sin|pwl|exp|sffm|am|table|model|params:)$/i.test(token)) return false;
	return true;
}

function isParamToken(token: string): boolean {
	return token.includes("=") || /^params?:$/i.test(token);
}

function stripInlineComment(line: string): string {
	return line.replace(/\s+[;$].*$/, "");
}

function normalizeNodeKey(value: string): string {
	return normalizeMainCircuitNode(value) || normalizeProbeText(value);
}

function dedupeMainCircuitNodes(nodes: MainCircuitNode[]): MainCircuitNode[] {
	const seen = new Map<string, MainCircuitNode>();
	const result: MainCircuitNode[] = [];
	for (const node of nodes) {
		const key = normalizeNodeKey(node.node);
		if (!key) continue;
		const existing = seen.get(key);
		if (existing) {
			if (existing.probeType === undefined && node.probeType !== undefined) {
				existing.probeType = node.probeType;
			}
			continue;
		}
		seen.set(key, node);
		result.push(node);
	}
	return result;
}

function isGround(value: string): boolean {
	return /^(0|gnd)$/i.test(value.trim());
}

function dedupeCurrentProbes(probes: CurrentProbe[]): CurrentProbe[] {
	const seen = new Set<string>();
	return probes.filter((probe) => {
		const key = `${probe.name}:${probe.nodeA}:${probe.nodeB}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}
