import type { AnalysisArtifact, AnalysisExecution, AnalysisRequest } from "../../core/analysis/contracts";
import type { WorstCaseObjective, WorstCaseResult } from "../../features/worst-case/types";
import type {
	MonteCarloResult,
	MonteCarloSampleProgress,
} from "../../features/monte-carlo/types";
import type { ProbeTarget } from "../../shared/probe";
import type { AnalysisType, SpiceCommandType } from "../../shared/analysis-types";
import type { SimulationResult } from "../../shared/waveform";

export interface CommonRunOptions {
	probeNodes?: ProbeTarget[];
	/** 可选。ngspice 兼容网表（ngbehavior），空/缺省 = 不兼容。例如 "ps"、"ltpsa"、"hs"。 */
	compatMode?: string;
}

export interface MonteCarloRunOptions extends CommonRunOptions {
	sampleCount: number;
	seed?: number;
	/** 可选。每个样本完成时的实时回调（用于边跑边渲染）。 */
	onSampleProgress?: (progress: MonteCarloSampleProgress) => void;
	/** 可选。中止信号：abort 后在下一个样本前停止，返回已完成的部分结果。 */
	signal?: AbortSignal;
}

export interface WorstCaseRunOptions extends CommonRunOptions {
	objective: WorstCaseObjective;
}

export type StandardAnalysisRequest = AnalysisRequest<SpiceCommandType, CommonRunOptions>;
export type MonteCarloAnalysisRequest = AnalysisRequest<"monte-carlo", MonteCarloRunOptions>;
export type WorstCaseAnalysisRequest = AnalysisRequest<"worst-case", WorstCaseRunOptions>;
export type ProductAnalysisRequest = StandardAnalysisRequest | MonteCarloAnalysisRequest | WorstCaseAnalysisRequest;

export type WaveformArtifact = AnalysisArtifact<"waveform", SimulationResult>;
export type MonteCarloArtifact = AnalysisArtifact<"monte-carlo", MonteCarloResult>;
export type WorstCaseArtifact = AnalysisArtifact<"worst-case", WorstCaseResult>;
export type ProductAnalysisArtifact = WaveformArtifact | MonteCarloArtifact | WorstCaseArtifact;

export type ProductAnalysisExecution = AnalysisExecution<AnalysisType, ProductAnalysisArtifact>;
