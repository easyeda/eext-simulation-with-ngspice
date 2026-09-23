import type {
	OpenSpiceSessionResult,
	OpenSpiceSessionOptions,
	SpiceEngine,
	SpiceExecutionSession,
	SpiceRunRequest,
	SpiceRunResult,
} from "../../core/simulation/spice-engine";
import { addSyntheticCurrentProbeTraces } from "../../shared/current-probe-traces";
import { trimLogs } from "../../shared/logs";
import { normalizeNgspiceRawResult } from "./raw-normalize";
import { NGSPICE_RESULT_PROTOCOL_VERSION } from "./raw-result";
import { NgspiceSession } from "./session";
import { isWasmNgspiceAvailable } from "./wasm-loader";

export interface WasmSpiceEngineOptions {
	wasmBaseUrl: string;
	timeoutMs: number;
}

export class WasmSpiceEngine implements SpiceEngine {
	readonly id = "ngspice-wasm";
	readonly resultProtocolVersion = NGSPICE_RESULT_PROTOCOL_VERSION;

	constructor(private readonly options: WasmSpiceEngineOptions) {}

	isAvailable(): boolean {
		return isWasmNgspiceAvailable();
	}

	async open(netlist: string, options: OpenSpiceSessionOptions = {}): Promise<OpenSpiceSessionResult> {
		throwIfAborted(options.signal);
		// Run mode 由各 feature runner 记录（带分析类型上下文）
		const logs: string[] = [];
		const session = await NgspiceSession.open(netlist, {
			wasmBaseUrl: this.options.wasmBaseUrl,
			timeoutMs: this.options.timeoutMs,
			probeNodes: options.probeNodes,
			capturePolicy: options.capturePolicy,
			compatMode: options.compatMode,
		}, logs);
		try {
			throwIfAborted(options.signal);
		}
		catch (error) {
			session.dispose();
			throw error;
		}
		return { session: new WasmExecutionSession(session), logs: trimLogs(logs) };
	}
}

class WasmExecutionSession implements SpiceExecutionSession {
	constructor(private readonly session: NgspiceSession) {}

	setRandomSeed(seed: number): void {
		if (!Number.isFinite(seed)) throw new Error("Random seed must be finite");
		this.session.command(`setseed ${Math.trunc(seed)}`);
	}

	async run(request: SpiceRunRequest = {}): Promise<SpiceRunResult> {
		const logs: string[] = [];
		try {
			throwIfAborted(request.signal);
			this.session.clearResultData();
			this.prepare(request);
			this.session.run();
			throwIfAborted(request.signal);
			let raw = this.session.readResult();
			if (raw.diagnostics.errors.some((error) => /no data saved/i.test(error))) {
				// 数字/混合电路的输出目标可能是纯数字节点，save v(node) 无效导致
				// ngspice 报 no data saved；数字事件数据其实已采集。回退 save all 重跑一次。
				logs.push("warning: configured saved vectors produced no data; retrying with save all");
				this.session.clearResultData();
				this.session.command("save all");
				this.prepare(request);
				this.session.run();
				throwIfAborted(request.signal);
				raw = this.session.readResult();
			}
			logs.push(...raw.diagnostics.warnings.map((warning) => `warning: ${warning}`));
			if (raw.diagnostics.errors.length) {
				return {
					ok: false,
					measurements: [],
					datasets: [],
					nativeResult: raw,
					logs: trimLogs([...logs, ...raw.diagnostics.errors]),
					error: raw.diagnostics.errors.join("\n"),
				};
			}
			const datasets = request.captureWaveforms
				? addSyntheticCurrentProbeTraces(
					normalizeNgspiceRawResult(raw, this.session.netlist, {
						targets: this.session.targets,
					}),
					this.session.netlist,
				)
				: [];
			return {
				ok: true,
				measurements: raw.measurements.map((measurement) => ({ ...measurement })),
				datasets,
				nativeResult: raw,
				logs: trimLogs(logs),
			};
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				ok: false,
				measurements: [],
				datasets: [],
				nativeResult: null,
				logs: trimLogs([...logs, message]),
				error: message,
			};
		}
	}

	dispose(): void {
		this.session.dispose();
	}

	private prepare(request: SpiceRunRequest): void {
		for (const operation of request.beforeRun ?? []) {
			if (operation.kind === "resample-source") {
				this.session.command("mc_source");
				continue;
			}
			for (const [name, value] of Object.entries(operation.values)) {
				this.session.command(`alterparam ${name.toLowerCase()}=${formatNgspiceNumber(value)}`);
			}
			this.session.command("reset");
		}
	}
}

function formatNgspiceNumber(value: number): string {
	if (!Number.isFinite(value)) throw new Error("SPICE parameter assignment must be finite");
	return value === 0 ? "0" : value.toExponential(15).replace(/\.?0+e/, "e");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("Simulation aborted", "AbortError");
}
