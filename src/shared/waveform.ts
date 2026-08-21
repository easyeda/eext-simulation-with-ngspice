import type { AnalysisType, SpiceCommandType } from "./analysis-types";

export type AxisScale = "linear" | "log";
export type AxisSide = "left" | "right";

export interface WaveformAxis {
  id: string;
  name: string;
  unit: string;
  scale: AxisScale;
  side?: AxisSide;
}

export interface WaveformTrace {
  id: string;
  name: string;
  axisId: string;
  unit: string;
  points: Array<[number, number]>;
  color?: string;
  meta?: {
    sampleIndex?: number;
    caseId?: string;
    caseKind?: string;
    probeKey?: string;
    sourceTraceId?: string;
    sourceTraceName?: string;
  };
}

export interface WaveformDataset {
  id: string;
  productAnalysisType: AnalysisType;
  spiceCommandType: SpiceCommandType;
  title: string;
  command: string;
  xAxis: WaveformAxis;
  yAxes: WaveformAxis[];
  traces: WaveformTrace[];
  meta: {
    simulationId: string;
    sampleCount: number;
    generatedAt: number;
    sourcePlot?: string;
  };
}

export interface SimulationResult {
  datasets: WaveformDataset[];
  activeDatasetId: string | null;
  preferredTraceIdsByDataset?: Record<string, string[]>;
}
