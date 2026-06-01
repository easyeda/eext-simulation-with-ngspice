import type { AnalysisType } from "./types";

const COMMANDS: Array<[AnalysisType, RegExp]> = [
  ["transient", /^\s*\.tran\b/im],
  ["ac", /^\s*\.ac\b/im],
  ["dc", /^\s*\.dc\b/im],
];

export function detectAnalysisType(netlist: string): AnalysisType {
  const cleaned = stripComments(netlist);
  for (const [type, pattern] of COMMANDS) {
    if (pattern.test(cleaned)) return type;
  }
  return "transient";
}

export function findAnalysisCommand(netlist: string): string {
  const cleaned = stripComments(netlist);
  const match = cleaned.match(/^\s*\.(tran|ac|dc)\b[^\r\n]*/im);
  return match ? match[0].trim() : "";
}

export function normalizeNetlistForNgspice(netlist: string): { netlist: string; logs: string[] } {
  const logs: string[] = [];
  const normalized = netlist.split(/\r?\n/).map((line) => normalizeAcCommandLine(line, logs)).join("\n");
  return { netlist: normalized, logs };
}

export function inferProbeNodes(netlist: string, maxNodes = 120): string[] {
  const explicit = inferExplicitProbeNodes(netlist);
  if (explicit.length) return explicit.slice(0, maxNodes);

  const nodes = new Set<string>();
  for (const rawLine of stripComments(netlist).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(".") || line.startsWith("+")) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 3) continue;

    const element = tokens[0].charAt(0).toUpperCase();
    for (const node of candidateNodesForElement(element, tokens)) {
      const normalized = normalizeProbeNode(node);
      if (!normalized) continue;
      nodes.add(normalized);
      if (nodes.size >= maxNodes) return [...nodes];
    }
  }

  return [...nodes];
}

export function stripComments(netlist: string): string {
  return netlist
    .split(/\r?\n/)
    .filter((line) => !/^\s*\*/.test(line))
    .join("\n");
}

export function titleForAnalysis(type: AnalysisType): string {
  if (type === "ac") return "幅频特性 — Gain / Phase vs Frequency";
  if (type === "dc") return "DC 扫描 — Voltage / Current vs Sweep";
  return "瞬态分析 — Voltage / Current vs Time";
}

function normalizeAcCommandLine(line: string, logs: string[]): string {
  if (!/^\s*\.ac\b/i.test(line)) return line;

  const newline = line.match(/\r?\n$/)?.[0] ?? "";
  const lineWithoutNewline = newline ? line.slice(0, -newline.length) : line;
  const commentMatch = /(\s*[;$].*)$/.exec(lineWithoutNewline);
  const comment = commentMatch?.[1] ?? "";
  const command = comment ? lineWithoutNewline.slice(0, -comment.length) : lineWithoutNewline;
  const leading = command.match(/^\s*/)?.[0] ?? "";
  const tokens = command.trim().split(/\s+/);

  if (tokens.length < 5 || !/^\.ac$/i.test(tokens[0])) return line;

  let changed = false;
  for (const index of [3, 4]) {
    const next = normalizeAcFrequencyToken(tokens[index]);
    if (next !== tokens[index]) {
      logs.push(`已兼容 AC 频率单位: ${tokens[index]} -> ${next}`);
      tokens[index] = next;
      changed = true;
    }
  }

  return changed ? `${leading}${tokens.join(" ")}${comment}${newline}` : line;
}

function normalizeAcFrequencyToken(token: string): string {
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)M(?:[hH][zZ])?$/.exec(token);
  return match ? `${match[1]}Meg` : token;
}

export function inferAxisId(name: string, unitHint = ""): string {
  const text = `${name} ${unitHint}`.toLowerCase();
  if (text.includes("phase") || text.includes("deg")) return "phase";
  if (text.includes("gain") || text.includes("db")) return "gain";
  if (/^i\(| current|\ba\b|amp/.test(text)) return "current";
  return "voltage";
}

export function inferUnit(name: string, axisId: string): string {
  const text = name.toLowerCase();
  if (axisId === "phase") return "deg";
  if (axisId === "gain") return "dB";
  if (axisId === "current" || /^i\(/.test(text)) return "A";
  return "V";
}

function inferExplicitProbeNodes(netlist: string): string[] {
  const nodes = new Set<string>();
  for (const rawLine of stripComments(netlist).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\s*\.(probe|save|plot|print)\b/i.test(line)) continue;
    for (const match of line.matchAll(/\bv\(([^)]+)\)/gi)) {
      const normalized = normalizeProbeNode(match[1]);
      if (normalized) nodes.add(normalized);
    }
  }
  return [...nodes];
}

function candidateNodesForElement(element: string, tokens: string[]): string[] {
  switch (element) {
    case "R":
    case "C":
    case "L":
    case "V":
    case "I":
    case "D":
      return tokens.slice(1, 3);
    case "Q":
      return tokens.slice(1, 4);
    case "J":
    case "M":
      return tokens.slice(1, 5);
    case "X":
      return tokens.slice(1, -1).filter(looksLikeNodeToken);
    default:
      return tokens.slice(1).filter(looksLikeNodeToken);
  }
}

function looksLikeNodeToken(token: string): boolean {
  if (!token || token.includes("=")) return false;
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[a-z]+)?$/i.test(token)) return false;
  if (/^(dc|ac|pulse|sin|pwl|exp|sffm|am|table|model)$/i.test(token)) return false;
  return true;
}

function normalizeProbeNode(token: string): string {
  const node = token.trim().replace(/^v\((.*)\)$/i, "$1");
  if (!node || /^(0|gnd)$/i.test(node)) return "";
  return node.toLowerCase();
}
