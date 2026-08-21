import type { SpiceCommandType } from "../../shared/analysis-types";
import { findAnalysisDirectives } from "../../shared/netlist";

export interface NativeCommandValidation {
	ok: boolean;
	command: string;
	spiceCommandType: SpiceCommandType | null;
	error?: string;
}

export function validateNativeAnalysisCommand(
	netlist: string,
	declaredType?: SpiceCommandType,
): NativeCommandValidation {
	if (/^\s*\.control\b/im.test(netlist)) {
		return {
			ok: false,
			command: "",
			spiceCommandType: null,
			error: "Netlist must not contain a .control block",
		};
	}
	const directives = findAnalysisDirectives(netlist);
	if (!directives.length) {
		return {
			ok: false,
			command: "",
			spiceCommandType: null,
			error: "Netlist has no supported .tran, .ac, or .dc command",
		};
	}
	if (directives.length > 1) {
		const detail = directives.map((directive) => `${directive.command} (line ${directive.lineNumber})`).join(", ");
		return {
			ok: false,
			command: "",
			spiceCommandType: null,
			error: `Netlist contains multiple native analysis commands: ${detail}`,
		};
	}
	const [{ command, type: spiceCommandType }] = directives;
	if (declaredType && declaredType !== spiceCommandType) {
		return {
			ok: false,
			command,
			spiceCommandType,
			error: `Selected ${declaredType} analysis does not match netlist ${spiceCommandType}`,
		};
	}
	return { ok: true, command, spiceCommandType };
}
