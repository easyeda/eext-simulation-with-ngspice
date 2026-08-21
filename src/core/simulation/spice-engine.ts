import type { ProbeTarget } from "../../shared/probe";
import type { WaveformDataset } from "../../shared/waveform";

export interface SpiceMeasurement {
	name: string;
	value: number;
	raw?: string;
}

export type SpiceScalar = number | null;

export interface SpiceVectorSnapshot {
	name: string;
	qualifiedName: string;
	valueType: "real" | "complex";
	vectorType: number;
	vectorFlags: number;
	real: SpiceScalar[];
	imag?: SpiceScalar[];
}

export interface SpicePlotSnapshot {
	name: string;
	vectors: SpiceVectorSnapshot[];
}

export interface SpiceEventPoint {
	step: number;
	dcop: number;
	value: string;
}

export interface SpiceEventNode {
	name: string;
	points: SpiceEventPoint[];
}

/** 与具体后端无关的原生结果快照，供后续非波形分析转换器使用。 */
export interface SpiceNativeResult {
	currentPlot: string | null;
	plots: SpicePlotSnapshot[];
	events: SpiceEventNode[];
	measurements: SpiceMeasurement[];
	diagnostics: {
		errors: string[];
		warnings: string[];
	};
}

export type SpiceSessionOperation =
	| { kind: "resample-source" }
	| { kind: "alter-parameters"; values: Record<string, number> };

export interface SpiceRunRequest {
	beforeRun?: SpiceSessionOperation[];
	captureWaveforms?: boolean;
	signal?: AbortSignal;
}

export interface SpiceRunResult {
	ok: boolean;
	measurements: SpiceMeasurement[];
	datasets: WaveformDataset[];
	nativeResult: SpiceNativeResult | null;
	logs: string[];
	error?: string;
}

export interface SpiceExecutionSession {
	setRandomSeed(seed: number): void;
	run(request?: SpiceRunRequest): Promise<SpiceRunResult>;
	dispose(): void;
}

export interface OpenSpiceSessionResult {
	session: SpiceExecutionSession;
	logs: string[];
}

export type SpiceVectorSelection =
	| { mode: "output-targets" }
	| { mode: "all" }
	| { mode: "explicit"; vectors: string[] };

export interface SpiceSessionCapturePolicy {
	/**
	 * required：无法推导主电路探针时拒绝运行。
	 * optional：存在探针时使用，同时允许没有探针的标量或表格分析。
	 * none：不推导也不注册探针。
	 */
	probeRequirement?: "required" | "optional" | "none";
	/** 独立于界面展示，控制 ngspice 的向量保存范围。 */
	vectorSelection?: SpiceVectorSelection;
}

export interface OpenSpiceSessionOptions {
	probeNodes?: ProbeTarget[];
	capturePolicy?: SpiceSessionCapturePolicy;
	signal?: AbortSignal;
	/** 可选。ngspice 兼容模式（ngbehavior），空/缺省 = 不兼容。例如 "ps"、"ltpsa"、"hs"。 */
	compatMode?: string;
}

/**
 * 批处理分析依赖的最小 SPICE 执行端口。
 * 实时流式仿真需要独立端口，不能把持续事件塞入一次性 SpiceRunResult。
 */
export interface SpiceEngine {
	readonly id: string;
	readonly resultProtocolVersion: number;
	isAvailable(): boolean;
	open(netlist: string, options?: OpenSpiceSessionOptions): Promise<OpenSpiceSessionResult>;
}
