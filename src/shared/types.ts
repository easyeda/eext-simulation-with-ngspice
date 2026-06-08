export type AnalysisType = "transient" | "ac" | "dc";
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
}

export interface WaveformDataset {
  id: string;
  analysisType: AnalysisType;
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

export interface SimulationResponse {
  ok: boolean;
  result?: SimulationResult;
  logs: string[];
  error?: string;
}

export interface EdaProbeNode {
  ProbeNode: string;
  ProbeType?: number;
  LowLevel?: number;
  HighLevel?: number;
}

export interface ImportedNetlist {
  sequence: number;
  netlist: string;
  analysisType: AnalysisType;
  source: string;
  fileName: string;
  command: string;
  lineCount: number;
  importedAt: number;
}

export interface ImportNetlistRequest {
  netlist: string;
  analysisType?: AnalysisType;
  source?: string;
  fileName?: string;
}

export interface ImportNetlistResponse {
  ok: boolean;
  imported?: ImportedNetlist;
  error?: string;
}

export interface EngineStatus {
  port: number;
  url: string;
  configuredPath: boolean;
  enginePath: string | null;
  cliPath?: string | null;
  mode?: string;
  managedProcess: boolean;
  connected: boolean;
  status: "connected" | "not_connected" | "not_configured";
  message: string;
}
