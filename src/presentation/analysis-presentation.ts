import type { WaveformDataset } from "../shared/waveform";

export interface AnalysisTraceChoice {
	id: string;
	label: string;
	traceName: string;
	description: string;
}

export interface AnalysisOverlayHost {
	setDataset(dataset: WaveformDataset | null): void;
	getDataset(): WaveformDataset | null;
	setHighlightedTraceIds(traceIds: string[] | null): void;
	appendLog(message: string): void;
	resizeCharts(): void;
}

export interface AnalysisPresentationController {
	clear(): void;
	refreshLocale(): void;
	setRunning(running: boolean): void;
}

export interface AnalysisTraceChoiceController extends AnalysisPresentationController {
	traceChoices(): AnalysisTraceChoice[];
	activeTraceChoiceId(): string;
	selectTraceChoice(id: string): void;
}

export function supportsTraceChoices(
	controller: AnalysisPresentationController | null,
): controller is AnalysisTraceChoiceController {
	if (!controller) return false;
	const candidate = controller as Partial<AnalysisTraceChoiceController>;
	return typeof candidate.traceChoices === "function"
		&& typeof candidate.activeTraceChoiceId === "function"
		&& typeof candidate.selectTraceChoice === "function";
}
