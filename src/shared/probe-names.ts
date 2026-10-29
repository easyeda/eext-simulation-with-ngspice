export function probeNameCandidates(value: string): string[] {
	const text = normalizeProbeText(value);
	if (!text) return [];
	// AC 曲线名带 "gain"/"phase" 后缀、数字曲线名带 "digital" 后缀，
	// 剥离后再生成候选，否则探针节点匹配不上对应曲线。
	const base = text.replace(/\s+(gain|phase)$/i, "").replace(/\s+digital$/, "");
	const unwrapped = base.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
	const scoped = normalizeScopeProbeNode(base);
	const scopedUnwrapped = scoped.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
	return [...new Set([
		text,
		base,
		unwrapped,
		`v(${unwrapped})`,
		`i(${unwrapped})`,
		normalizeCurrentProbeName(unwrapped),
		scoped,
		scopedUnwrapped,
		`v(${scopedUnwrapped})`,
	].map(normalizeProbeText).filter(Boolean))];
}

export function normalizeCurrentProbeName(name: string): string {
	const text = normalizeProbeText(name);
	if (!text) return "";
	return /^i\(/i.test(text) ? text : `i(${text})`;
}

export function normalizeProbeText(value: string): string {
	return String(value).trim().toLowerCase();
}

export function sameProbeName(a: string, b: string): boolean {
	return normalizeProbeText(a) === normalizeProbeText(b);
}

function normalizeScopeProbeNode(value: string): string {
	const raw = String(value).trim();
	if (!raw) return "";
	if (/^[vi]\(/i.test(raw)) return raw;
	if (canUseDataAsDouble(raw)) return `V(${raw})`;
	return raw.charAt(0).toLowerCase() + raw.slice(1);
}

function canUseDataAsDouble(value: string): boolean {
	const text = value.trim();
	if (!text) return false;
	const match = text.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
	if (!match) return false;
	const number = Number(match[0]);
	return Number.isFinite(number) && number !== 0;
}
