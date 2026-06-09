import { inferUnit } from "./netlist";
import type { WaveformDataset, WaveformTrace } from "./types";

export interface CurrentProbe {
  name: string;
  nodeA: string;
  nodeB: string;
  resistance: number;
}

export function extractCurrentProbes(netlist: string): CurrentProbe[] {
  const probes: CurrentProbe[] = [];
  for (const rawLine of netlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("*") || !/^XAM/i.test(line)) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) continue;
    const [name, nodeA, nodeB] = tokens;
    if (!nodeA || !nodeB || isGround(nodeA) || isGround(nodeB)) continue;
    probes.push({
      name: normalizeCurrentProbeName(name),
      nodeA,
      nodeB,
      resistance: 1e-3,
    });
  }
  return dedupeCurrentProbes(probes);
}

export function augmentNetlistWithCurrentProbeSaves(netlist: string): { netlist: string; logs: string[] } {
  const saveTargets = new Set<string>();
  for (const probe of extractCurrentProbes(netlist)) {
    saveTargets.add(`v(${probe.nodeA})`);
    saveTargets.add(`v(${probe.nodeB})`);
  }
  if (!saveTargets.size) return { netlist, logs: [] };

  const existing = existingSaveTargets(netlist);
  const missing = [...saveTargets].filter((target) => !existing.has(target.toLowerCase()));
  if (!missing.length) return { netlist, logs: [] };

  const saveBlock = missing.map((target) => `.save ${target}`).join("\n");
  const endPattern = /^\s*\.end\s*$/im;
  const nextNetlist = endPattern.test(netlist)
    ? netlist.replace(endPattern, `${saveBlock}\n.end`)
    : `${netlist.trimEnd()}\n${saveBlock}\n.end`;
  return {
    netlist: nextNetlist,
    logs: [`已补充 XAM 电流探针保存向量: ${missing.join(", ")}`],
  };
}

export function addSyntheticCurrentProbeTraces(datasets: WaveformDataset[], netlist: string): WaveformDataset[] {
  const currentProbes = extractCurrentProbes(netlist);
  if (!currentProbes.length) return datasets;

  return datasets.map((dataset) => {
    if (dataset.analysisType === "ac") return dataset;
    const nextTraces = [...dataset.traces];
    let changed = false;
    for (const probe of currentProbes) {
      if (nextTraces.some((trace) => sameProbeName(trace.name, probe.name))) continue;
      const a = findVoltageTrace(dataset.traces, probe.nodeA);
      const b = findVoltageTrace(dataset.traces, probe.nodeB);
      if (!a || !b) continue;
      const points = subtractAlignedPoints(a.points, b.points, probe.resistance);
      if (!points.length) continue;
      nextTraces.push({
        id: slugify(`current:${probe.name}`),
        name: probe.name,
        axisId: "current",
        unit: inferUnit(probe.name, "current"),
        points,
      });
      changed = true;
    }
    if (!changed) return dataset;
    const hasCurrentAxis = dataset.yAxes.some((axis) => axis.id === "current");
    return {
      ...dataset,
      yAxes: hasCurrentAxis
        ? dataset.yAxes
        : [...dataset.yAxes, { id: "current", name: "Current", unit: "A", scale: "linear", side: dataset.yAxes.length ? "right" : "left" }],
      traces: nextTraces,
      meta: {
        ...dataset.meta,
        sampleCount: nextTraces.reduce((sum, trace) => sum + trace.points.length, 0),
      },
    };
  });
}

function findVoltageTrace(traces: WaveformTrace[], node: string): WaveformTrace | null {
  const candidates = new Set(probeNameCandidates(node));
  return traces.find((trace) => trace.axisId === "voltage" && traceMatchesWanted(trace, candidates)) ?? null;
}

function subtractAlignedPoints(a: Array<[number, number]>, b: Array<[number, number]>, divisor: number): Array<[number, number]> {
  const length = Math.min(a.length, b.length);
  const points: Array<[number, number]> = [];
  for (let index = 0; index < length; index += 1) {
    const ax = a[index][0];
    const bx = b[index][0];
    if (!Number.isFinite(ax) || !Number.isFinite(bx) || Math.abs(ax - bx) > Math.max(1e-15, Math.abs(ax) * 1e-9)) continue;
    points.push([ax, (a[index][1] - b[index][1]) / divisor]);
  }
  return points;
}

function traceMatchesWanted(trace: WaveformTrace, wanted: Set<string>): boolean {
  const names = probeNameCandidates(trace.name);
  names.push(...probeNameCandidates(trace.id));
  return names.some((name) => wanted.has(name));
}

function probeNameCandidates(value: string): string[] {
  const text = normalizeProbeText(value);
  if (!text) return [];
  const unwrapped = text.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
  return [...new Set([
    text,
    unwrapped,
    `v(${unwrapped})`,
    `i(${unwrapped})`,
    normalizeCurrentProbeName(unwrapped),
  ].map(normalizeProbeText).filter(Boolean))];
}

function existingSaveTargets(netlist: string): Set<string> {
  const targets = new Set<string>();
  for (const rawLine of netlist.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\s*\.save\b/i.test(line)) continue;
    for (const token of line.split(/\s+/).slice(1)) {
      targets.add(token.toLowerCase());
    }
  }
  return targets;
}

function normalizeCurrentProbeName(name: string): string {
  const text = normalizeProbeText(name);
  if (!text) return "";
  return /^i\(/i.test(text) ? text : `i(${text})`;
}

function normalizeProbeText(value: string): string {
  return String(value).trim().toLowerCase();
}

function sameProbeName(a: string, b: string): boolean {
  return normalizeProbeText(a) === normalizeProbeText(b);
}

function isGround(value: string): boolean {
  return /^(0|gnd)$/i.test(value.trim());
}

function dedupeCurrentProbes(probes: CurrentProbe[]): CurrentProbe[] {
  const seen = new Set<string>();
  return probes.filter((probe) => {
    const key = `${probe.name}:${probe.nodeA}:${probe.nodeB}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "trace";
}
