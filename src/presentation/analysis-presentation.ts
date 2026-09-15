import type { WaveformDataset } from "../shared/waveform";

export interface AnalysisTraceChoice {
	id: string;
	label: string;
	traceName: string;
	description: string;
}

/** 绘图区几何（数据范围 + 像素矩形），供叠加画布对齐 ECharts 坐标。 */
export interface ChartPlotGeometry {
	left: number;
	right: number;
	top: number;
	bottom: number;
	xMin: number;
	xMax: number;
	xLog: boolean;
	yMin: number;
	yMax: number;
	yLog: boolean;
}

export interface AnalysisOverlayHost {
	setDataset(dataset: WaveformDataset | null, opts?: { keepView?: boolean }): void;
	getDataset(): WaveformDataset | null;
	setHighlightedTraceIds(traceIds: string[] | null): void;
	appendLog(message: string): void;
	resizeCharts(): void;
	/** 可选。当前绘图区几何（无数据时为 null）。 */
	getPlotGeometry?(): ChartPlotGeometry | null;
	/** 可选。注册每次渲染完成后的回调，返回取消函数。 */
	onChartAfterRender?(callback: () => void): () => void;
	/** 可选。当前显示模式（线/点/线+点），供叠加画布同步。 */
	getDisplayMode?(): "line" | "points" | "both";
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
