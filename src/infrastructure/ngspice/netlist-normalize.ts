export function normalizeNetlistForNgspice(netlist: string): { netlist: string; logs: string[] } {
	const logs: string[] = [];
	const normalized = netlist.split(/\r?\n/).map((line) => normalizeAcCommandLine(line, logs)).join("\n");
	return { netlist: normalized, logs };
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
		if (next === tokens[index]) continue;
		logs.push(`Normalized AC frequency token ${tokens[index]} -> ${next}`);
		tokens[index] = next;
		changed = true;
	}
	return changed ? `${leading}${tokens.join(" ")}${comment}${newline}` : line;
}

function normalizeAcFrequencyToken(token: string): string {
	const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)M(?:[hH][zZ])?$/.exec(token);
	return match ? `${match[1]}Meg` : token;
}
