import type { SpiceCommandType } from "./analysis-types";

export interface SpiceAnalysisDirective {
	type: SpiceCommandType;
	command: string;
	lineNumber: number;
}

export function detectSpiceCommandType(netlist: string): SpiceCommandType {
	return tryDetectSpiceCommandType(netlist) ?? "transient";
}

/** 仅当网表中恰好存在一个原生分析指令时返回其类型。 */
export function tryDetectSpiceCommandType(netlist: string): SpiceCommandType | null {
	const directives = findAnalysisDirectives(netlist);
	return directives.length === 1 ? directives[0].type : null;
}

export function spiceCommandTypeFromCommand(command: string): SpiceCommandType | null {
	const match = /^\s*\.(tran|ac|dc)\b/i.exec(command);
	if (!match) return null;
	return match[1].toLowerCase() === "tran" ? "transient" : match[1].toLowerCase() as SpiceCommandType;
}

export function findAnalysisCommand(netlist: string): string {
	const directives = findAnalysisDirectives(netlist);
	return directives.length === 1 ? directives[0].command : "";
}

export function findAnalysisDirectives(netlist: string): SpiceAnalysisDirective[] {
	const directives: SpiceAnalysisDirective[] = [];
	const lines = netlist.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (/^\s*\*/.test(line)) continue;
		const match = /^\s*\.(tran|ac|dc)\b[^\r\n]*/i.exec(line);
		if (!match) continue;
		const keyword = match[1].toLowerCase();
		directives.push({
			type: keyword === "tran" ? "transient" : keyword as SpiceCommandType,
			command: match[0].trim(),
			lineNumber: index + 1,
		});
	}
	return directives;
}

export function stripComments(netlist: string): string {
	return netlist
		.split(/\r?\n/)
		.filter((line) => !/^\s*\*/.test(line))
		.join("\n");
}

export function inferAxisId(name: string, unitHint = ""): string {
	const text = `${name} ${unitHint}`.toLowerCase();
	if (text.includes("phase") || text.includes("deg")) return "phase";
	if (text.includes("gain") || text.includes("db")) return "gain";
	if (/^i\(| current|\ba\b|amp/.test(text)) return "current";
	return "voltage";
}

export function inferUnit(name: string, axisId: string): string {
	const text = name.toLowerCase();
	if (axisId === "phase") return "deg";
	if (axisId === "gain") return "dB";
	if (axisId === "current" || /^i\(/.test(text)) return "A";
	return "V";
}
