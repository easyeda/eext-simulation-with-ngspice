import { findAnalysisCommand } from "../../shared/netlist";
import { inferMainCircuitOutputProbes } from "../../shared/probe-discovery";
import type { ProbeTarget } from "../../shared/probe";
import type {
	SpiceSessionCapturePolicy,
	SpiceVectorSelection,
} from "../../core/simulation/spice-engine";
import { parseNgspiceRawResult, type NgspiceRawResult } from "./raw-result";
import {
	loadNgspiceWasmModule,
	type NgspiceWasmModule,
	type WasmNgspiceRunOptions,
} from "./wasm-loader";
import { normalizeNetlistForNgspice } from "./netlist-normalize";

export interface NgspiceEngine {
	loadNetlist(netlist: string, compatMode?: string): void;
	run?(): number | void;
	command?(text: string): number | void;
	clearResultData?(): void;
	getRawResultJson(): string;
	reset?(): void;
}

interface NgspiceRuntimeModule extends NgspiceWasmModule {
	NgSpiceWasm?: new () => NgspiceEngine;
}

export interface ProbeRegistrationTarget {
	node: string;
	probeType: number;
	highLevel: number;
	lowLevel: number;
}

export interface OpenNgspiceSessionOptions extends WasmNgspiceRunOptions {
	capturePolicy?: SpiceSessionCapturePolicy;
	/** 可选。ngspice 兼容网表（ngbehavior），空/缺省 = 不兼容。例如 "ps"、"ltpsa"、"hs"。 */
	compatMode?: string;
}

/**
 * 每个 Session 只持有一个 NgSpiceWasm 引擎实例。Monte Carlo、Worst Case 等重复分析
 * 复用这个 Session，避免反复创建 WASM 引擎。
 */
export class NgspiceSession {
	readonly netlist: string;
	readonly targets: ProbeRegistrationTarget[];
	private disposed = false;

	private constructor(
		private readonly engine: NgspiceEngine,
		netlist: string,
		targets: ProbeRegistrationTarget[],
	) {
		this.netlist = netlist;
		this.targets = targets;
	}

	static async open(
		netlist: string,
		options: OpenNgspiceSessionOptions = {},
		logs: string[] = [],
	): Promise<NgspiceSession> {
		if (!netlist.trim()) throw new Error("Netlist is empty");
		const prepared = normalizeNetlistForNgspice(netlist);
		logs.push(...prepared.logs);
		logs.push(`Analysis command: ${findAnalysisCommand(prepared.netlist) || "not detected"}`);

		const capturePolicy = normalizeCapturePolicy(options.capturePolicy);
		const targets = capturePolicy.probeRequirement === "none"
			? []
			: outputRegistrationTargets(prepared.netlist, options.probeNodes);
		if (capturePolicy.probeRequirement === "required" && !targets.length) {
			throw new Error("No main-circuit output nodes were inferred");
		}

		const module = await loadNgspiceWasmModule(options, logs) as NgspiceRuntimeModule;
		const EngineCtor = module.NgSpiceWasm;
		if (typeof EngineCtor !== "function") throw new Error("ngspice WASM module does not expose NgSpiceWasm");

		const engine = new EngineCtor();
		try {
			engine.loadNetlist(prepared.netlist, options.compatMode ?? "");
			if (options.compatMode) logs.push(`ngspice compatibility mode: ${options.compatMode}`);
			if (typeof engine.getRawResultJson !== "function") {
				throw new Error("NgSpiceWasm does not expose result protocol v2");
			}
			const session = new NgspiceSession(engine, prepared.netlist, targets);
			session.optionalCommand("set noaskquit");
			session.configureSavedVectors(capturePolicy.vectorSelection, logs);
			logs.push("ngspice netlist loaded");
			logs.push(`main-circuit output targets: ${targets.length}`);
			logs.push(`ngspice vector capture: ${capturePolicy.vectorSelection.mode}`);
			if (options.probeNodes?.length) logs.push(`EDA default-visible probes: ${options.probeNodes.length}`);
			return session;
		}
		catch (error) {
			try { engine.reset?.(); } catch { /* 尽力清理，不覆盖原始异常。 */ }
			throw error;
		}
	}

	clearResultData(): void {
		this.assertOpen();
		this.engine.clearResultData?.();
	}

	command(command: string): void {
		this.assertOpen();
		if (typeof this.engine.command !== "function") throw new Error("NgSpiceWasm.command() is not available");
		const code = this.engine.command(command);
		if (typeof code === "number" && code !== 0) throw new Error(`ngSpice_Command("${command}") failed with code ${code}`);
	}

	optionalCommand(command: string): void {
		this.assertOpen();
		if (typeof this.engine.command !== "function") return;
		const code = this.engine.command(command);
		if (typeof code === "number" && code !== 0) throw new Error(`ngSpice_Command("${command}") failed with code ${code}`);
	}

	run(): void {
		this.assertOpen();
		if (typeof this.engine.run === "function") {
			const code = this.engine.run();
			if (typeof code === "number" && code !== 0) throw new Error(`NgSpiceWasm.run() failed with code ${code}`);
			return;
		}
		this.command("run");
	}

	readResult(): NgspiceRawResult {
		this.assertOpen();
		return parseNgspiceRawResult(this.engine.getRawResultJson());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try { this.engine.reset?.(); } catch { /* 尽力清理，不影响释放流程。 */ }
	}

	private assertOpen(): void {
		if (this.disposed) throw new Error("ngspice session is already disposed");
	}

	private configureSavedVectors(selection: SpiceVectorSelection, logs: string[]): void {
		if (typeof this.engine.command !== "function") return;
		if (selection.mode === "all") {
			this.runSaveCommand(["all"], logs);
			return;
		}
		const vectors = selection.mode === "explicit"
			? normalizeVectorNames(selection.vectors)
			: [...new Set(this.targets
				// save 主电路所有节点（含数字目标）。数字门输出等无 v() 向量的节点
				// 会被 ngspice 忽略，不影响有效向量导出；V 源驱动的数字节点电压照常保存。
				.map((target) => voltageExpression(target.node))
				.filter(Boolean))];
		if (!vectors.length) return;
		for (let index = 0; index < vectors.length; index += 40) {
			if (!this.runSaveCommand(vectors.slice(index, index + 40), logs)) return;
		}
		logs.push(`ngspice saved vectors configured: ${vectors.length}`);
	}

	private runSaveCommand(vectors: string[], logs: string[]): boolean {
		const code = this.engine.command?.(`save ${vectors.join(" ")}`);
		if (typeof code === "number" && code !== 0) {
			logs.push(`warning: ngspice vector selection failed with code ${code}; result extraction may include extra vectors`);
			return false;
		}
		return true;
	}
}

export function outputRegistrationTargets(netlist: string, probeNodes: ProbeTarget[] = []): ProbeRegistrationTarget[] {
	const targets = inferMainCircuitOutputProbes(netlist, probeNodes).map((probe) => ({
		node: probe.node,
		probeType: probe.probeType ?? 0,
		highLevel: probe.highLevel ?? 5,
		lowLevel: probe.lowLevel ?? 0,
	}));
	const seen = new Set<string>();
	return targets.filter((target) => {
		const key = `${target.node.trim().toLowerCase()}:${target.probeType}:${target.highLevel}:${target.lowLevel}`;
		if (!target.node.trim() || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function voltageExpression(node: string): string {
	const value = node.trim();
	if (!value) return "";
	return /^v\(.+\)$/i.test(value) ? value : `v(${value})`;
}

function normalizeCapturePolicy(
	policy: SpiceSessionCapturePolicy | undefined,
): Required<SpiceSessionCapturePolicy> {
	return {
		probeRequirement: policy?.probeRequirement ?? "required",
		vectorSelection: policy?.vectorSelection ?? { mode: "output-targets" },
	};
}

function normalizeVectorNames(vectors: string[]): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const vector of vectors) {
		const name = vector.trim();
		const key = name.toLowerCase();
		if (!name || seen.has(key)) continue;
		seen.add(key);
		normalized.push(name);
	}
	return normalized;
}
