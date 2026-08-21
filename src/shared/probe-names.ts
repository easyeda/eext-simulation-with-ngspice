export function probeNameCandidates(value: string): string[] {
	const text = normalizeProbeText(value);
	if (!text) return [];
	// 数字探针 trace 名为 "<node> digital"，候选集按基础节点名生成，
	// 让 "out digital" 能与探针 "out" / "v(out)" 匹配。
	const digitalBase = text.replace(/\s+digital$/, "");
	const unwrapped = digitalBase.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
	const scoped = normalizeScopeProbeNode(digitalBase);
	const scopedUnwrapped = scoped.replace(/^v\((.*)\)$/i, "$1").replace(/^i\((.*)\)$/i, "$1");
	return [...new Set([
		text,
		digitalBase,
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
