import { detectAnalysisType, findAnalysisCommand, inferAxisId, inferUnit, titleForAnalysis } from "./netlist";
import type { AnalysisType, WaveformAxis, WaveformDataset, WaveformTrace } from "./types";

type AnyRecord = Record<string, unknown>;

interface TraceBuilder {
  id: string;
  name: string;
  axisId: string;
  unit: string;
  points: Array<[number, number]>;
}

interface DatasetBuilder {
  id: string;
  analysisType: AnalysisType;
  command: string;
  sourcePlot: string;
  xName: string;
  xUnit: string;
  xScale: "linear" | "log";
  traces: Map<string, TraceBuilder>;
}

export function normalizeNgspiceMessages(messages: unknown[], netlist: string): WaveformDataset[] {
  const parsed = messages.map(parseMessage).filter(isRecord);
  const direct = extractDirectDatasets(parsed, netlist);
  if (direct.length) return direct;

  const streamed = extractVecsaDatasets(parsed, netlist);
  if (streamed.length) return streamed;

  const jlcWaveVectors = extractJlcWaveVectorDatasets(parsed, netlist);
  if (jlcWaveVectors.length) return jlcWaveVectors;

  const vectorData = extractVectorDatasets(parsed, netlist);
  if (vectorData.length) return vectorData;

  const textTables = extractTextTables(messages, netlist);
  if (textTables.length) return textTables;

  return [];
}

export function hasWaveDataCandidate(messages: unknown[]): boolean {
  for (const message of messages) {
    const parsed = parseMessage(message);
    let found = false;
    visit(parsed, (record) => {
      if (found) return;
      if (
        Array.isArray(record.traces)
        || Array.isArray(record.vecsa)
        || Array.isArray(record.ngspiceWaveVector)
        || isRecord(record.vectors)
        || isRecord(record.allVecs)
      ) {
        found = true;
      }
    });
    if (found) return true;
  }
  return false;
}

function extractDirectDatasets(messages: AnyRecord[], netlist: string): WaveformDataset[] {
  const datasets: WaveformDataset[] = [];
  for (const message of messages) {
    visit(message, (record) => {
      if (!Array.isArray(record.traces)) return;
      const traces = record.traces
        .map((trace, index) => coerceDirectTrace(trace, index))
        .filter((trace): trace is WaveformTrace => Boolean(trace && trace.points.length));
      if (!traces.length) return;

      const type = coerceAnalysisType(record.analysisType) ?? detectAnalysisType(netlist);
      const command = asString(record.command) || findAnalysisCommand(netlist);
      const xAxis = coerceAxis(record.xAxis, type, "x");
      const yAxes = coerceYAxes(record.yAxes, type, traces);
      datasets.push(finalizeDataset({
        id: asString(record.id) || `direct-${datasets.length + 1}`,
        analysisType: type,
        title: asString(record.title) || titleForAnalysis(type),
        command,
        xAxis,
        yAxes,
        traces,
        meta: {
          simulationId: asString(record.simulationId) || asString(record.sessionId) || `direct-${Date.now()}`,
          sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
          generatedAt: Date.now(),
          sourcePlot: asString(record.sourcePlot) || asString(record.plot),
        },
      }));
    });
  }
  return dedupeDatasets(datasets);
}

function extractVecsaDatasets(messages: AnyRecord[], netlist: string): WaveformDataset[] {
  const builders = new Map<string, DatasetBuilder>();
  const fallbackType = detectAnalysisType(netlist);
  const command = findAnalysisCommand(netlist);

  for (const message of messages) {
    visit(message, (record) => {
      if (!Array.isArray(record.vecsa)) return;
      const vectors = record.vecsa.filter(isRecord);
      if (vectors.length < 2) return;

      const scale = findScaleVector(vectors) ?? vectors[0];
      const x = readNumeric(scale, ["creal", "real", "value", "x"]);
      if (x === null) return;

      const plotName = asString(record.plot) || asString(record.plotName) || asString(record.curplot) || "";
      const type = inferAnalysisFromText(`${plotName} ${command}`, fallbackType);
      const builder = getBuilder(builders, {
        analysisType: type,
        command,
        sourcePlot: plotName || type,
        xName: vectorName(scale) || defaultXName(type),
      });

      for (const vector of vectors) {
        if (vector === scale || vector.is_scale === true) continue;
        const name = vectorName(vector);
        if (!name) continue;
        const real = readNumeric(vector, ["creal", "real", "value", "y"]);
        const imag = readNumeric(vector, ["cimag", "imag", "imaginary"]);
        if (real === null) continue;

        if (type === "ac" && imag !== null) {
          const magnitude = Math.sqrt(real * real + imag * imag);
          const gain = 20 * Math.log10(Math.max(magnitude, Number.MIN_VALUE));
          const phase = Math.atan2(imag, real) * 180 / Math.PI;
          addPoint(builder, `${name} gain`, "gain", "dB", x, gain);
          addPoint(builder, `${name} phase`, "phase", "deg", x, phase);
        } else {
          const axisId = inferAxisId(name);
          addPoint(builder, name, axisId, inferUnit(name, axisId), x, real);
        }
      }
    });
  }

  return buildersToDatasets(builders);
}

function extractJlcWaveVectorDatasets(messages: AnyRecord[], netlist: string): WaveformDataset[] {
  const datasets: WaveformDataset[] = [];
  const type = detectAnalysisType(netlist);
  const command = findAnalysisCommand(netlist);

  for (const message of messages) {
    visit(message, (record) => {
      if (!Array.isArray(record.ngspiceWaveVector)) return;

      const traces: WaveformTrace[] = [];
      for (const vector of record.ngspiceWaveVector.filter(isRecord)) {
        const id = asString(vector.id);
        if (!id) continue;

        traces.push(...jlcTrace(id, "voltData", vector.voltData, "voltage", "V", formatVoltageName(id)));
        traces.push(...jlcTrace(id, "currentData", vector.currentData, "current", "A", formatCurrentName(id)));
        traces.push(...jlcTrace(id, "digitalData", vector.digitalData, "voltage", "V", `${id} digital`));
        traces.push(...jlcTrace(id, "gainData", vector.gainData, "gain", "dB", `${formatVoltageName(id)} gain`));
        traces.push(...jlcTrace(id, "phaseData", vector.phaseData, "phase", "deg", `${formatVoltageName(id)} phase`));
      }

      if (!traces.length) return;
      datasets.push(finalizeDataset({
        id: `jlc-${type}-${datasets.length + 1}`,
        analysisType: type,
        title: titleForAnalysis(type),
        command,
        xAxis: defaultXAxis(type),
        yAxes: axesForTraces(type, traces),
        traces,
        meta: {
          simulationId: asString(record.sessionId) || `jlc-${Date.now()}`,
          sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
          generatedAt: Date.now(),
          sourcePlot: "jlc-ngspice-wave-vector",
        },
      }));
    });
  }

  return dedupeDatasets(datasets);
}

function jlcTrace(
  vectorId: string,
  field: string,
  value: unknown,
  axisId: string,
  unit: string,
  name: string,
): WaveformTrace[] {
  const points = coercePointPairs(value);
  if (!points.length) return [];
  return [{
    id: slugify(`${axisId}:${vectorId}:${field}`),
    name,
    axisId,
    unit,
    points,
  }];
}

function coercePointPairs(value: unknown): Array<[number, number]> {
  if (!Array.isArray(value)) return [];
  return value
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const x = scalarFromUnknown(point[0]);
      const y = scalarFromUnknown(point[1]);
      return x !== null && y !== null ? [x, y] as [number, number] : null;
    })
    .filter((point): point is [number, number] => Boolean(point));
}

function formatVoltageName(id: string): string {
  return /^v\(/i.test(id) ? id.toLowerCase() : `v(${id})`;
}

function formatCurrentName(id: string): string {
  return /^i\(/i.test(id) ? id.toLowerCase() : `${id} current`;
}

function extractVectorDatasets(messages: AnyRecord[], netlist: string): WaveformDataset[] {
  const builders = new Map<string, DatasetBuilder>();
  const fallbackType = detectAnalysisType(netlist);
  const command = findAnalysisCommand(netlist);

  for (const message of messages) {
    visit(message, (record) => {
      const vectorSource = firstRecord(record.vectors, record.allVecs, record.vecs, record.variables);
      if (vectorSource) {
        addVectorRecord(builderKey(record, command, fallbackType), builders, vectorSource, record, command, fallbackType);
      }

      if (Array.isArray(record.vectors)) {
        const asMap = vectorArrayToMap(record.vectors);
        if (Object.keys(asMap).length) {
          addVectorRecord(builderKey(record, command, fallbackType), builders, asMap, record, command, fallbackType);
        }
      }
    });
  }

  return buildersToDatasets(builders);
}

function addVectorRecord(
  keySeed: string,
  builders: Map<string, DatasetBuilder>,
  vectorSource: AnyRecord,
  context: AnyRecord,
  command: string,
  fallbackType: AnalysisType,
) {
  const names = Object.keys(vectorSource);
  if (names.length < 2) return;
  const xName = names.find((name) => /^(time|frequency|freq|v-sweep|sweep|dc)$/i.test(name)) ?? names[0];
  const xValues = arrayFromUnknown(vectorSource[xName]);
  if (!xValues.length) return;

  const plotName = asString(context.plot) || asString(context.plotName) || keySeed;
  const type = inferAnalysisFromText(`${plotName} ${command} ${xName}`, fallbackType);
  const builder = getBuilder(builders, {
    analysisType: type,
    command,
    sourcePlot: plotName || type,
    xName,
  });

  for (const name of names) {
    if (name === xName) continue;
    const values = arrayFromUnknown(vectorSource[name]);
    if (!values.length) continue;

    for (let index = 0; index < Math.min(xValues.length, values.length); index += 1) {
      const x = scalarFromUnknown(xValues[index]);
      const real = scalarFromUnknown(values[index]);
      const imag = imaginaryFromUnknown(values[index]);
      if (x === null || real === null) continue;

      if (type === "ac" && imag !== null) {
        const magnitude = Math.sqrt(real * real + imag * imag);
        addPoint(builder, `${name} gain`, "gain", "dB", x, 20 * Math.log10(Math.max(magnitude, Number.MIN_VALUE)));
        addPoint(builder, `${name} phase`, "phase", "deg", x, Math.atan2(imag, real) * 180 / Math.PI);
      } else {
        const axisId = inferAxisId(name);
        addPoint(builder, name, axisId, inferUnit(name, axisId), x, real);
      }
    }
  }
}

function extractTextTables(messages: unknown[], netlist: string): WaveformDataset[] {
  const text = messages.map((message) => typeof message === "string" ? message : "").join("\n");
  if (!text.trim()) return [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const headerIndex = lines.findIndex((line) => /\b(time|frequency|freq|v-sweep|sweep)\b/i.test(line) && /[a-z_(]/i.test(line));
  if (headerIndex < 0) return [];

  const headers = lines[headerIndex].split(/\s+/).filter((part) => !/^index$/i.test(part));
  if (headers.length < 2) return [];

  const xName = headers[0];
  const valueNames = headers.slice(1);
  const type = inferAnalysisFromText(`${xName} ${findAnalysisCommand(netlist)}`, detectAnalysisType(netlist));
  const builder = getBuilder(new Map(), {
    analysisType: type,
    command: findAnalysisCommand(netlist),
    sourcePlot: "stdout-table",
    xName,
  });

  for (let lineIndex = headerIndex + 1; lineIndex < lines.length; lineIndex += 1) {
    const tokens = lines[lineIndex].split(/\s+/);
    const numeric = tokens.map((token) => Number(token)).filter((value) => Number.isFinite(value));
    if (numeric.length < headers.length) continue;
    const x = numeric[0];
    valueNames.forEach((name, index) => {
      const y = numeric[index + 1];
      const axisId = type === "ac" && /db|gain/i.test(name) ? "gain" : inferAxisId(name);
      addPoint(builder, name, axisId, inferUnit(name, axisId), x, y);
    });
  }

  return builder.traces.size ? [builderToDataset(builder)] : [];
}

function getBuilder(builders: Map<string, DatasetBuilder>, seed: {
  analysisType: AnalysisType;
  command: string;
  sourcePlot: string;
  xName: string;
}): DatasetBuilder {
  const key = `${seed.analysisType}:${seed.sourcePlot || seed.command || "plot"}`;
  const existing = builders.get(key);
  if (existing) return existing;

  const xAxis = defaultXAxis(seed.analysisType, seed.xName);
  const builder: DatasetBuilder = {
    id: slugify(key),
    analysisType: seed.analysisType,
    command: seed.command,
    sourcePlot: seed.sourcePlot,
    xName: xAxis.name,
    xUnit: xAxis.unit,
    xScale: xAxis.scale,
    traces: new Map(),
  };
  builders.set(key, builder);
  return builder;
}

function addPoint(builder: DatasetBuilder, name: string, axisId: string, unit: string, x: number, y: number) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;
  if (builder.analysisType === "ac" && x <= 0) return;
  const id = `${axisId}:${name}`;
  let trace = builder.traces.get(id);
  if (!trace) {
    trace = { id: slugify(id), name, axisId, unit, points: [] };
    builder.traces.set(id, trace);
  }
  trace.points.push([x, y]);
}

function buildersToDatasets(builders: Map<string, DatasetBuilder>): WaveformDataset[] {
  return [...builders.values()].map(builderToDataset).filter((dataset) => dataset.traces.length);
}

function builderToDataset(builder: DatasetBuilder): WaveformDataset {
  const traces = [...builder.traces.values()].map((trace) => sanitizeTrace(trace)).filter((trace) => trace.points.length);
  return finalizeDataset({
    id: builder.id,
    analysisType: builder.analysisType,
    title: titleForAnalysis(builder.analysisType),
    command: builder.command,
    xAxis: {
      id: "x",
      name: builder.xName,
      unit: builder.xUnit,
      scale: builder.xScale,
    },
    yAxes: axesForTraces(builder.analysisType, traces),
    traces,
    meta: {
      simulationId: `${builder.id}-${Date.now()}`,
      sampleCount: traces.reduce((sum, trace) => sum + trace.points.length, 0),
      generatedAt: Date.now(),
      sourcePlot: builder.sourcePlot,
    },
  });
}

function finalizeDataset(dataset: WaveformDataset): WaveformDataset {
  return {
    ...dataset,
    traces: dataset.traces
      .map((trace) => sanitizeTrace(trace))
      .filter((trace) => trace.points.length),
    yAxes: dataset.yAxes.length ? dataset.yAxes : axesForTraces(dataset.analysisType, dataset.traces),
  };
}

function sanitizeTrace(trace: WaveformTrace | TraceBuilder): WaveformTrace {
  const seen = new Set<string>();
  const points = trace.points
    .filter((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .sort((a, b) => a[0] - b[0])
    .filter((point) => {
      const key = `${point[0]}:${point[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { ...trace, points };
}

function coerceDirectTrace(value: unknown, index: number): WaveformTrace | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name) || asString(value.id) || `Trace ${index + 1}`;
  const rawPoints = Array.isArray(value.points) ? value.points : Array.isArray(value.data) ? value.data : [];
  const points = rawPoints
    .map((point) => {
      if (Array.isArray(point)) {
        const x = scalarFromUnknown(point[0]);
        const y = scalarFromUnknown(point[1]);
        return x !== null && y !== null ? [x, y] as [number, number] : null;
      }
      if (isRecord(point)) {
        const x = readNumeric(point, ["x", "time", "frequency"]);
        const y = readNumeric(point, ["y", "value", "real", "creal"]);
        return x !== null && y !== null ? [x, y] as [number, number] : null;
      }
      return null;
    })
    .filter((point): point is [number, number] => Boolean(point));
  const axisId = asString(value.axisId) || inferAxisId(name, asString(value.unit));
  return {
    id: asString(value.id) || slugify(`${axisId}:${name}`),
    name,
    axisId,
    unit: asString(value.unit) || inferUnit(name, axisId),
    color: asString(value.color) || undefined,
    points,
  };
}

function coerceAxis(value: unknown, type: AnalysisType, kind: "x"): WaveformAxis {
  if (isRecord(value)) {
    return {
      id: asString(value.id) || kind,
      name: asString(value.name) || defaultXName(type),
      unit: asString(value.unit) || defaultXUnit(type),
      scale: value.scale === "log" ? "log" : "linear",
    };
  }
  return defaultXAxis(type);
}

function coerceYAxes(value: unknown, type: AnalysisType, traces: WaveformTrace[]): WaveformAxis[] {
  if (Array.isArray(value)) {
    const axes = value.filter(isRecord).map((axis) => ({
      id: asString(axis.id) || "voltage",
      name: asString(axis.name) || "Voltage",
      unit: asString(axis.unit) || "V",
      scale: axis.scale === "log" ? "log" as const : "linear" as const,
      side: axis.side === "right" ? "right" as const : "left" as const,
    }));
    if (axes.length) return axes;
  }
  return axesForTraces(type, traces);
}

function axesForTraces(type: AnalysisType, traces: Array<WaveformTrace | TraceBuilder>): WaveformAxis[] {
  const used = new Set(traces.map((trace) => trace.axisId));
  if (type === "ac") {
    const axes: WaveformAxis[] = [{ id: "gain", name: "Gain", unit: "dB", scale: "linear", side: "left" }];
    if (used.has("phase")) axes.push({ id: "phase", name: "Phase", unit: "deg", scale: "linear", side: "right" });
    return axes;
  }

  const axes: WaveformAxis[] = [];
  if (used.has("voltage") || !used.has("current")) {
    axes.push({ id: "voltage", name: "Voltage", unit: "V", scale: "linear", side: "left" });
  }
  if (used.has("current")) {
    axes.push({ id: "current", name: "Current", unit: "A", scale: "linear", side: axes.length ? "right" : "left" });
  }
  if (!axes.length) axes.push({ id: "voltage", name: "Voltage", unit: "V", scale: "linear", side: "left" });
  return axes;
}

function defaultXAxis(type: AnalysisType, rawName?: string): WaveformAxis {
  const name = rawName || defaultXName(type);
  return {
    id: "x",
    name: normalizeXName(type, name),
    unit: defaultXUnit(type, name),
    scale: type === "ac" ? "log" : "linear",
  };
}

function defaultXName(type: AnalysisType): string {
  if (type === "ac") return "Frequency";
  if (type === "dc") return "Sweep";
  return "Time";
}

function normalizeXName(type: AnalysisType, rawName: string): string {
  if (/freq/i.test(rawName)) return "Frequency";
  if (/time/i.test(rawName)) return "Time";
  if (type === "dc") return rawName || "Sweep";
  return defaultXName(type);
}

function defaultXUnit(type: AnalysisType, rawName = ""): string {
  if (type === "ac" || /freq/i.test(rawName)) return "Hz";
  if (type === "transient" || /time/i.test(rawName)) return "s";
  return "";
}

function findScaleVector(vectors: AnyRecord[]): AnyRecord | null {
  return vectors.find((vector) => vector.is_scale === true)
    ?? vectors.find((vector) => /^(time|frequency|freq|v-sweep|sweep|dc)$/i.test(vectorName(vector)))
    ?? null;
}

function vectorName(vector: AnyRecord): string {
  return asString(vector.name) || asString(vector.vecname) || asString(vector.id) || "";
}

function vectorArrayToMap(value: unknown[]): AnyRecord {
  const result: AnyRecord = {};
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = asString(item.name) || asString(item.id);
    if (!name) continue;
    result[name] = item.data ?? item.values ?? item.points ?? item.value;
  }
  return result;
}

function builderKey(record: AnyRecord, command: string, fallbackType: AnalysisType): string {
  return asString(record.plot) || asString(record.plotName) || inferAnalysisFromText(command, fallbackType);
}

function inferAnalysisFromText(text: string, fallback: AnalysisType): AnalysisType {
  if (/\b(ac|frequency|freq)\b|\.ac\b/i.test(text)) return "ac";
  if (/\b(dc|sweep)\b|\.dc\b/i.test(text)) return "dc";
  if (/\b(tran|transient|time)\b|\.tran\b/i.test(text)) return "transient";
  return fallback;
}

function coerceAnalysisType(value: unknown): AnalysisType | null {
  if (value === "transient" || value === "tran") return "transient";
  if (value === "ac" || value === "frequency") return "ac";
  if (value === "dc") return "dc";
  return null;
}

function parseMessage(message: unknown): unknown {
  if (typeof message !== "string") return message;
  try {
    return JSON.parse(message);
  } catch {
    return { text: message };
  }
}

function firstRecord(...values: unknown[]): AnyRecord | null {
  for (const value of values) {
    if (isRecord(value)) return value;
  }
  return null;
}

function arrayFromUnknown(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value)) {
    const nested = value.data ?? value.values ?? value.points;
    if (Array.isArray(nested)) return nested;
  }
  return [];
}

function scalarFromUnknown(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (Array.isArray(value)) return scalarFromUnknown(value[0]);
  if (isRecord(value)) return readNumeric(value, ["creal", "real", "value", "y"]);
  return null;
}

function imaginaryFromUnknown(value: unknown): number | null {
  if (Array.isArray(value)) return scalarFromUnknown(value[1]);
  if (isRecord(value)) return readNumeric(value, ["cimag", "imag", "imaginary"]);
  return null;
}

function readNumeric(record: AnyRecord, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visit(value: unknown, visitor: (record: AnyRecord) => void, depth = 0) {
  if (depth > 8) return;
  if (isRecord(value)) {
    visitor(value);
    for (const child of Object.values(value)) visit(child, visitor, depth + 1);
  } else if (Array.isArray(value)) {
    for (const child of value) visit(child, visitor, depth + 1);
  }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trace";
}

function dedupeDatasets(datasets: WaveformDataset[]): WaveformDataset[] {
  const seen = new Set<string>();
  return datasets.filter((dataset) => {
    const key = `${dataset.analysisType}:${dataset.command}:${dataset.traces.map((trace) => trace.id).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
