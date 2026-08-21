import { isAnalysisType, isSpiceCommandType } from "../shared/analysis-types";
import { t } from "../shared/i18n";
import type { AnalysisType } from "../shared/analysis-types";

interface AnalysisUiDefinition {
	label: () => string;
	runLabel: () => string;
	runningLabel: () => string;
	failureMessage: (error: string) => string;
	successMessage?: () => string;
	showToleranceInput: boolean;
}

const standard = (label: () => string): AnalysisUiDefinition => ({
	label,
	runLabel: () => t("action.run"),
	runningLabel: () => t("action.running"),
	failureMessage: (error) => t("log.simulationFailed", error),
	successMessage: () => t("log.simulationComplete"),
	showToleranceInput: false,
});

export const analysisUiCatalog: Record<AnalysisType, AnalysisUiDefinition> = {
	transient: standard(() => t("analysis.transient")),
	ac: standard(() => "AC"),
	dc: standard(() => "DC"),
	"monte-carlo": {
		label: () => "Monte Carlo",
		runLabel: () => t("action.runMc"),
		runningLabel: () => t("action.mcRunning"),
		failureMessage: (error) => t("log.mcFailed", error),
		showToleranceInput: false,
	},
	"worst-case": {
		label: () => "Worst Case",
		runLabel: () => t("action.run"),
		runningLabel: () => t("action.running"),
		failureMessage: (error) => t("log.wcFailed", error),
		successMessage: () => t("log.wcComplete"),
		showToleranceInput: true,
	},
};

export function analysisLabel(type: AnalysisType): string {
	return analysisUiCatalog[type].label();
}

export function parseAnalysisType(value: unknown): AnalysisType | null {
	return isAnalysisType(value) ? value : null;
}

export function isStandardAnalysis(type: AnalysisType): boolean {
	return isSpiceCommandType(type);
}
