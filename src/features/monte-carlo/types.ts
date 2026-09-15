import type { WaveformDataset } from "../../shared/waveform";
import type { McWaveformStore } from "./waveform-store";

export type MonteCarloMeasurementSource = "parameter" | "output";

export interface MonteCarloSpecLimit {
	min?: number;
	max?: number;
}

export interface MonteCarloMeasurementConfig {
	id: string;
	label?: string;
	source?: MonteCarloMeasurementSource;
	spec?: MonteCarloSpecLimit;
	/** 可选。测量值单位，如相位测量的 "deg"。 */
	unit?: string;
}

export interface MonteCarloMeasurement {
	id: string;
	name: string;
	label: string;
	source: MonteCarloMeasurementSource;
	value: number;
	/** 可选。测量值单位，如相位测量的 "deg"。 */
	unit?: string;
	raw?: string;
}

export interface MonteCarloSampleResult {
	sampleIndex: number;
	ok: boolean;
	measurements: MonteCarloMeasurement[];
	error?: string;
	logs?: string[];
}

/** MC 单样本完成时的实时进度（store 为累积引用，随样本增加持续增长）。 */
export interface MonteCarloSampleProgress {
	completed: number;
	total: number;
	store: McWaveformStore;
	template: WaveformDataset | null;
}

export interface MonteCarloSummary {
	measurementId: string;
	label: string;
	/** 可选。测量值单位，如相位测量的 "deg"。 */
	unit?: string;
	count: number;
	min: number;
	max: number;
	mean: number;
	stdDev: number;
	median: number;
	p5: number;
	p95: number;
	yieldRate?: number;
}

export interface MonteCarloResult {
	seed: number;
	samples: MonteCarloSampleResult[];
	summaries: MonteCarloSummary[];
	measurementConfigs: MonteCarloMeasurementConfig[];
	representativeDatasets: WaveformDataset[];
	/** 全量波形累积存储（共享时间轴 + Float32 + 预算抽稀），立即模式叠加画布的数据源。 */
	waveformStore?: McWaveformStore;
	logs: string[];
}

export interface MonteCarloResponse {
	ok: boolean;
	result?: MonteCarloResult;
	logs: string[];
	error?: string;
}
