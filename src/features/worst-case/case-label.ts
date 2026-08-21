import type { WorstCaseRunResult } from "./types";

export function worstCaseTechnicalKindLabel(kind: WorstCaseRunResult["kind"], fallback: string): string {
	if (kind === "worst-low") return "Worst Low";
	if (kind === "worst-high") return "Worst High";
	if (kind === "nominal") return "Nominal";
	return fallback;
}

export function worstCaseTechnicalRunLabel(run: WorstCaseRunResult): string {
	return worstCaseTechnicalKindLabel(run.kind, run.id);
}
