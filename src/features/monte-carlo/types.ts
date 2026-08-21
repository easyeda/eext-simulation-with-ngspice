import type { WaveformDataset } from "../../shared/waveform";

export type MonteCarloWaveformCaptureMode = "none" | "first" | "all";
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
	datasets?: WaveformDataset[];
	error?: string;
	logs?: string[];
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
	logs: string[];
	waveformSampleLimit?: number;
}

export interface MonteCarloResponse {
	ok: boolean;
	result?: MonteCarloResult;
	logs: string[];
	error?: string;
}
