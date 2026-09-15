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
    /** 可选。MC scaffold 携带的全量波形存储（顶部导出用），不在普通 JSON 序列化路径。 */
    waveformStore?: unknown;
    /** 可选。MC scaffold 对应的探针 trace 名。 */
    probeTraceName?: string;
    /** 可选。当前高亮的样本号（跟随读数/交点圆点聚焦该样本）。 */
    highlightSampleIndex?: number;
  };
}

export interface SimulationResult {
  datasets: WaveformDataset[];
  activeDatasetId: string | null;
  preferredTraceIdsByDataset?: Record<string, string[]>;
}
