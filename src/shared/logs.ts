export function trimLogs(logs: string[], limit = 500): string[] {
	return logs.filter(Boolean).slice(-limit);
}
