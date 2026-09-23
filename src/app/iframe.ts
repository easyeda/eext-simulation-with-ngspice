import type {
	AnalysisPayload,
	NetlistImportMessage,
} from '../integrations/eda/messages';
import { connectNetlistClient } from '../integrations/eda/netlist-client';
import { netlistImportKey } from '../integrations/eda/import-policy';
import { probeDescriptorsToTargets } from '../integrations/eda/protocol/probe';
import { executeAnalysis, getEngineStatus } from '../application/analysis/service';
import type {
	ProductAnalysisArtifact,
	ProductAnalysisRequest,
} from '../application/analysis/contracts';
import { detectSpiceCommandType, findAnalysisCommand } from '../shared/netlist';
import type { ProbeTarget } from '../shared/probe';
import {
	getNumberLocale,
	initializeI18n,
	onLanguageChanged,
	t,
} from '../shared/i18n';
import { applyTranslations } from '../presentation/localization';
import { escapeHtml } from '../presentation/format';
import { iconHtml } from '../shared/icons';
import type { AnalysisType } from '../shared/analysis-types';
import type { WorstCaseObjective } from '../features/worst-case/types';
import { WorstCaseController } from '../presentation/worst-case/controller';
import { WaveformChart } from '../presentation/waveform/chart';
import { WaveformController } from '../presentation/waveform/controller';
import { WorkbenchController, type BottomPanelId } from '../presentation/workbench/controller';
import { MonteCarloHistogramChart } from '../presentation/monte-carlo/histogram-chart';
import { MonteCarloController } from '../presentation/monte-carlo/controller';
import { LogicChart } from '../presentation/logic/chart';
import { LogicController } from '../presentation/logic/controller';
import { iframeTemplate } from './template';
import { sampleNetlists, worstCaseSampleObjectives } from './sample-netlists';
import {
	supportsTraceChoices,
	type AnalysisPresentationController,
	type AnalysisTraceChoiceController,
} from '../presentation/analysis-presentation';
import { analysisLabel, analysisUiCatalog, isStandardAnalysis, parseAnalysisType } from './analysis-catalog';

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = iframeTemplate;
applyTranslations(app);
document.title = t('app.documentTitle');

const edaApp = query<HTMLElement>('.eda-app');
const fileInput = query<HTMLInputElement>('#fileInput');
const sampleSelect = query<HTMLSelectElement>('#sampleSelect');
const analysisTypeValue = query<HTMLElement>('#analysisTypeValue');
const analysisModeSelect = query<HTMLInputElement>('#analysisModeSelect');
const mcSampleCountInput = query<HTMLInputElement>('#mcSampleCountInput');
const mcSeedInput = query<HTMLInputElement>('#mcSeedInput');
const runButton = query<HTMLButtonElement>('#runButton');
const clearButton = query<HTMLButtonElement>('#clearButton');
const clearLogButton = query<HTMLButtonElement>('#clearLogButton');
const netlistInput = query<HTMLTextAreaElement>('#netlistInput');
const netlistMeta = query<HTMLElement>('#netlistMeta');
const compatModeSelect = query<HTMLSelectElement>('#compatModeSelect');
const logOutput = query<HTMLPreElement>('#logOutput');
const inputDock = query<HTMLElement>('.input-dock');
const inputDockButton = query<HTMLButtonElement>('#inputDockButton');
const mcSettingsDockButton = query<HTMLButtonElement>('#mcSettingsDockButton');
const mcSettingsInputView = query<HTMLElement>('#mcSettingsInputView');

const mcSampleCountVisible = query<HTMLInputElement>('#mcSampleCountVisible');
const mcSeedVisible = query<HTMLInputElement>('#mcSeedVisible');
const netlistInputView = query<HTMLElement>('#netlistInputView');
const verticalSplitter = query<HTMLElement>('#verticalSplitter');
const horizontalSplitter = query<HTMLElement>('#horizontalSplitter');
const chartToolbar = query<HTMLElement>('.chart-head');
const resultTabs = query<HTMLElement>('#resultTabs');
const fitButton = query<HTMLButtonElement>('#fitButton');
const traceSelectButton = query<HTMLButtonElement>('#traceSelectButton');
const displayButton = query<HTMLButtonElement>('#displayButton');
const displayLabel = query<HTMLElement>('#displayLabel');
const cursorModeButton = query<HTMLButtonElement>('#cursorModeButton');
const cursorModeLabel = query<HTMLElement>('#cursorModeLabel');
const waveformExportButton = query<HTMLButtonElement>('#waveformExportButton');
const expandButton = query<HTMLButtonElement>('#expandButton');
const traceDialog = query<HTMLElement>('#traceDialog');
const closeTraceDialog = query<HTMLButtonElement>('#closeTraceDialog');
const traceList = query<HTMLElement>('#traceList');
const traceFilterInput = query<HTMLInputElement>('#traceFilterInput');
const traceCount = query<HTMLElement>('#traceCount');
const traceAllButton = query<HTMLButtonElement>('#traceAllButton');
const traceClearButton = query<HTMLButtonElement>('#traceClearButton');
const traceInvertButton = query<HTMLButtonElement>('#traceInvertButton');
const traceApplyButton = query<HTMLButtonElement>('#traceApplyButton');
const traceCancelButton = query<HTMLButtonElement>('#traceCancelButton');
const bottomTabs = [...document.querySelectorAll<HTMLButtonElement>('.bottom-tab')];
const bottomPanes = [...document.querySelectorAll<HTMLElement>('.bottom-pane')];

const waveformChartElement = query<HTMLElement>('#chart');
const histogramChartElement = query<HTMLElement>('#histogramChart');
const logicChartElement = query<HTMLElement>('#logicChart');
const logicChartContextElement = query<HTMLElement>('#logicChartContext');

const chart = new WaveformChart(
	waveformChartElement,
	query<HTMLElement>('#chartTitle'),
	query<HTMLElement>('#chartBadges'),
);

const histogramChart = new MonteCarloHistogramChart(
	histogramChartElement,
	query<HTMLElement>('#histogramTitle'),
	query<HTMLElement>('#histogramBadges'),
);

const logicChart = new LogicChart(logicChartElement);

function resizeAnalysisCharts() {
	chart.resize();
	histogramChart.resize();
	logicChart.resize();
}

const workbench = new WorkbenchController({
	app: edaApp,
	inputDock,
	inputDockButton,
	verticalSplitter,
	horizontalSplitter,
	chartToolbar,
	expandButton,
	bottomTabs,
	bottomPanes,
	resizeChart: resizeAnalysisCharts,
});

type LogLevel = 'plugin' | 'ngspice' | 'warn' | 'error';
interface LogEntry { text: string; level: LogLevel }
let logLines: LogEntry[] = [];
let currentProbeNodes: ProbeTarget[] = [];
let lastAppliedImportKey = '';
let lastLoggedNetlistKey = '';
let lastAppliedImportAt = 0;
let lastAutoRunImportKey = '';
let lastAutoRunImportAt = 0;
let pendingAutoRunImportKey = '';
let runningSimulation = false;
let mcAbortController: AbortController | null = null;
let currentWorstCaseObjective: WorstCaseObjective | null = null;
let currentCompatMode: string | undefined;
let lastEngineAvailability: 'wasm' | 'missing' | null = null;
let activeInputView: 'netlist' | 'mcSettings' = 'netlist';
let currentNetlistMetaLabel = '';
let currentNetlistMetaSampleKey = '';

const IMPORT_RETRY_DEDUPE_MS = 2500;

let monteCarloController: MonteCarloController;

const waveformController: WaveformController = new WaveformController(chart, {
	resultTabs,
	fitButton,
	traceSelectButton,
	displayButton,
	displayLabel,
	cursorModeButton,
	cursorModeLabel,
	exportButton: waveformExportButton,
	dialog: traceDialog,
	closeDialogButton: closeTraceDialog,
	traceList,
	filterInput: traceFilterInput,
	traceCount,
	selectAllButton: traceAllButton,
	clearSelectionButton: traceClearButton,
	invertSelectionButton: traceInvertButton,
	applySelectionButton: traceApplyButton,
	cancelSelectionButton: traceCancelButton,
}, {
	activeTraceChoiceController,
	appendLog,
	resizeCharts: resizeAnalysisCharts,
	exportBaseName: (result): string => getAnalysisType() === 'monte-carlo'
		? `monte-carlo-waveform-${monteCarloController.selectedProbeLabel()}`
		: `waveform-${result.datasets[0]?.productAnalysisType || 'analysis'}-${result.datasets[0]?.spiceCommandType || 'waveform'}`,
});

const logicController = new LogicController(
	{
		viewTabs: query<HTMLElement>('#analysisViewTabs'),
		waveformTab: query<HTMLButtonElement>('#waveformViewTab'),
		histogramTab: query<HTMLButtonElement>('#histogramViewTab'),
		logicTab: query<HTMLButtonElement>('#logicViewTab'),
		waveformContext: query<HTMLElement>('#waveformChartContext'),
		waveformElement: waveformChartElement,
		logicContext: logicChartContextElement,
		logicElement: logicChartElement,
		logicFitButton: query<HTMLButtonElement>('#logicFitButton'),
		logicTraceSelectButton: query<HTMLButtonElement>('#logicTraceSelectButton'),
		logicDisplayButton: query<HTMLButtonElement>('#logicDisplayButton'),
		logicDisplayLabel: query<HTMLElement>('#logicDisplayLabel'),
		logicCursorModeButton: query<HTMLButtonElement>('#logicCursorModeButton'),
		logicCursorModeLabel: query<HTMLElement>('#logicCursorModeLabel'),
		dialog: traceDialog,
		closeDialogButton: closeTraceDialog,
		traceList,
		traceCount,
		selectAllButton: traceAllButton,
		clearSelectionButton: traceClearButton,
		invertSelectionButton: traceInvertButton,
		applySelectionButton: traceApplyButton,
		cancelSelectionButton: traceCancelButton,
	},
	logicChart,
	waveformController,
	appendLog,
);

monteCarloController = new MonteCarloController(
	{
		app: edaApp,
		status: query<HTMLElement>('#mcStatusText'),
		exportButton: query<HTMLButtonElement>('#mcExportButton'),
		summaryTab: query<HTMLButtonElement>('#mcSummaryTab'),
		samplesTab: query<HTMLButtonElement>('#mcSamplesTab'),
		summaryTable: query<HTMLElement>('#mcSummaryTable'),
		sampleTable: query<HTMLElement>('#mcSampleTable'),
		viewTabs: query<HTMLElement>('#analysisViewTabs'),
		waveformTab: query<HTMLButtonElement>('#waveformViewTab'),
		histogramTab: query<HTMLButtonElement>('#histogramViewTab'),
		waveformContext: query<HTMLElement>('#waveformChartContext'),
		histogramContext: query<HTMLElement>('#histogramChartContext'),
		waveformElement: waveformChartElement,
		histogramElement: histogramChartElement,
		histogramFitButton: query<HTMLButtonElement>('#histogramFitButton'),
		measurementSelect: query<HTMLSelectElement>('#histogramMeasurementSelect'),
		countButton: query<HTMLButtonElement>('#histogramCountButton'),
		percentButton: query<HTMLButtonElement>('#histogramPercentButton'),
		specToggle: query<HTMLInputElement>('#histogramSpecToggle'),
	},
	waveformController,
	histogramChart,
	() => currentProbeNodes,
	(panel, expand = false) => {
		workbench.activateBottomPanel(panel);
		if (expand) workbench.toggleBottomCollapsed(false);
	},
);

const worstCaseController = new WorstCaseController(
	{
		status: query<HTMLElement>('#wcStatusText'),
		exportButton: query<HTMLButtonElement>('#wcExportButton'),
		summaryTab: query<HTMLButtonElement>('#wcSummaryTab'),
		impactTab: query<HTMLButtonElement>('#wcImpactTab'),
		casesTab: query<HTMLButtonElement>('#wcCasesTab'),
		summaryTable: query<HTMLElement>('#wcSummaryTable'),
		impactTable: query<HTMLElement>('#wcImpactTable'),
		casesTable: query<HTMLElement>('#wcCasesTable'),
		app: edaApp,
	},
	waveformController,
	() => currentProbeNodes,
	() => {
		workbench.activateBottomPanel('wcSummary');
		workbench.toggleBottomCollapsed(false);
	},
);

const presentationControllers: Partial<Record<AnalysisType, AnalysisPresentationController>> = {
	'monte-carlo': monteCarloController,
	'worst-case': worstCaseController,
};

waveformController.install();

onLanguageChanged(refreshLocalizedUi);
updateAnalysisMode();
updateAnalysisControls();
void refreshEngineStatus();
void initializeI18n().then(() => {
	refreshLocalizedUi();
	appendLog(t('log.uiReady'));
	subscribeToEdaNetlist();
});

fileInput.addEventListener('change', async () => {
	const file = fileInput.files?.[0];
	if (!file) return;
	netlistInput.value = await file.text();
	sampleSelect.value = '';
	currentProbeNodes = [];
	setWorstCaseObjective(null);
	analysisModeSelect.value = detectSpiceCommandType(netlistInput.value);
	updateNetlistMeta(file.name);
	updateAnalysisMode();
	clearWaveformOnly();
	clearMonteCarloResults();
	clearWorstCaseResults();
	appendLog(t('log.localFileImported', file.name));
});

sampleSelect.addEventListener('change', () => {
	const key = sampleSelect.value as keyof typeof sampleNetlists | '';
	if (!key) return;
	netlistInput.value = sampleNetlists[key];
	currentProbeNodes = key === 'mcDivider' || key.startsWith('wc') ? [{ node: 'out' }] : [];
	setWorstCaseObjective(worstCaseSampleObjectives[key] || null);
	analysisModeSelect.value = key === 'mcDivider' ? 'monte-carlo' : key.startsWith('wc') ? 'worst-case' : detectSpiceCommandType(netlistInput.value);
	updateNetlistMeta('', key);
	updateAnalysisMode();
	clearWaveformOnly();
	clearMonteCarloResults();
	clearWorstCaseResults();
	updateAnalysisControls();
	appendLog(t('log.sampleLoaded', key));
});

netlistInput.addEventListener('input', () => {
	currentProbeNodes = [];
	setWorstCaseObjective(null);
	analysisModeSelect.value = detectSpiceCommandType(netlistInput.value);
	updateNetlistMeta();
	updateAnalysisMode();
	clearMonteCarloResults();
	clearWorstCaseResults();
});

runButton.addEventListener('click', () => {
	// MC 运行中：运行按钮即停止按钮（完成当前样本后停止，已绘波形保留）。
	if (runningSimulation && getAnalysisType() === 'monte-carlo' && mcAbortController) {
		mcAbortController.abort();
		appendLog(t('log.mcStopRequested'));
		return;
	}
	void runCurrentNetlist('manual');
});

compatModeSelect.addEventListener('change', () => {
	const mode = compatModeSelect.value.trim();
	currentCompatMode = mode || undefined;
	if (mode) appendLog(t('log.compatMode', mode));
});

clearButton.addEventListener('click', () => {
	netlistInput.value = '';
	sampleSelect.value = '';
	currentProbeNodes = [];
	setWorstCaseObjective(null);
	currentCompatMode = undefined;
	syncCompatSelect();
	analysisModeSelect.value = 'transient';
	mcSampleCountInput.value = '30';
	mcSeedInput.value = '';
	syncMcSettingsInputs();
	clearWaveformOnly();
	clearMonteCarloResults();
	clearWorstCaseResults();
	updateAnalysisMode();
	updateNetlistMeta();
	appendLog(t('log.cleared'));
});

clearLogButton.addEventListener('click', () => {
	logLines = [];
	renderLogs();
});

expandButton.addEventListener('click', () => workbench.toggleWaveExpanded());
bottomTabs.forEach((button) => {
	button.addEventListener('click', () => {
		const panel = (button.dataset.panel || 'log') as BottomPanelId;
		if (button.classList.contains('active')) {
			workbench.toggleBottomCollapsed();
			return;
		}
		workbench.activateBottomPanel(panel);
		workbench.toggleBottomCollapsed(false);
	});
});
inputDockButton.addEventListener('click', () => activateInputPanel('netlist'));
mcSettingsDockButton.addEventListener('click', () => activateInputPanel('mcSettings'));
// 可见输入框与 hidden 载体同步：非法输入标红不写入，合法值才落到载体供运行读取。
mcSampleCountVisible.addEventListener('input', () => {
	const valid = isValidMcInteger(mcSampleCountVisible.value, 1, 10000);
	mcSampleCountVisible.setAttribute('aria-invalid', valid || !mcSampleCountVisible.value.trim() ? 'false' : 'true');
	if (valid) mcSampleCountInput.value = mcSampleCountVisible.value;
});
mcSeedVisible.addEventListener('input', () => {
	const valid = isValidMcInteger(mcSeedVisible.value, 1, 2147483646);
	mcSeedVisible.setAttribute('aria-invalid', valid || !mcSeedVisible.value.trim() ? 'false' : 'true');
	if (valid) mcSeedInput.value = mcSeedVisible.value;
});
workbench.install();
document.addEventListener('keydown', (event) => {
	if (event.key !== 'Escape') return;
	if (waveformController.isTraceDialogOpen()) {
		waveformController.closeTraceDialog();
		return;
	}
	if (edaApp.classList.contains('wave-expanded')) workbench.toggleWaveExpanded(false);
});

function subscribeToEdaNetlist() {
	connectNetlistClient({
		onMessage: (imported, channel) => {
			if (netlistImportKey(imported) !== lastLoggedNetlistKey) {
				lastLoggedNetlistKey = netlistImportKey(imported);
				appendLog(t(
					channel === 'broadcast' ? 'log.broadcastReceived' : 'log.rpcReceived',
					imported.fileName,
					imported.defaultVisibleProbes.length,
				));
			}
			applyImportedNetlist(imported);
		},
		onConnected: () => appendLog(t('log.busConnected')),
		onUnavailable: () => appendLog(t('log.noMessageBus')),
		onError: (error) => appendLog(t('log.busFailed', error instanceof Error ? error.message : String(error))),
	});
}

/** 前端网表传入后初始化处理 */
function applyImportedNetlist(imported: NetlistImportMessage) {
	const importKey = netlistImportKey(imported);
	const now = Date.now();
	if (importKey === lastAppliedImportKey && now - lastAppliedImportAt < IMPORT_RETRY_DEDUPE_MS) {
		scheduleImportedAutoRun(imported, importKey);
		return;
	}
	lastAppliedImportKey = importKey;
	lastAppliedImportAt = now;
	netlistInput.value = imported.netlist;
	sampleSelect.value = '';
	currentProbeNodes = probeDescriptorsToTargets(imported.defaultVisibleProbes);
	applyImportedRunOptions(imported);
	clearWaveformOnly();
	clearMonteCarloResults();
	clearWorstCaseResults();
	updateAnalysisControls();
	updateAnalysisMode(imported.analysis.type);
	if (currentProbeNodes.length) appendLog(t('log.probesReceived', currentProbeNodes.length));
	updateNetlistMeta(`${imported.fileName} · ${analysisLabel(imported.analysis.type)}`);
	appendLog(t('log.netlistImported', 'EasyEDA Pro', imported.fileName));
	const command = findAnalysisCommand(imported.netlist);
	appendLog(t(
		'log.analysisDetected',
		analysisLabel(imported.analysis.type),
		command ? t('log.commandSuffix', command) : '',
	));
	scheduleImportedAutoRun(imported, importKey);
}

function applyImportedRunOptions(imported: NetlistImportMessage) {
	const monteCarlo = imported.analysis.type === 'monte-carlo' ? imported.analysis : null;
	setWorstCaseObjective(imported.analysis.type === 'worst-case'
		? normalizeWorstCaseObjective(imported.analysis)
		: null);
	currentCompatMode = imported.compatMode;
	analysisModeSelect.value = imported.analysis.type;
	if (currentCompatMode) appendLog(t('log.compatMode', currentCompatMode));
	syncCompatSelect();

	if (imported.analysis.type !== 'monte-carlo') return;
	if (!monteCarlo) {
		appendLog(t('log.mcConfigMissing'));
		return;
	}

	mcSampleCountInput.value = String(monteCarlo.sampleCount);
	mcSeedInput.value = typeof monteCarlo.seed === 'number' && Number.isFinite(monteCarlo.seed) ? String(Math.trunc(monteCarlo.seed)) : '';
	syncMcSettingsInputs();
	appendLog(t(
		'log.mcConfig',
		monteCarlo.sampleCount,
		typeof monteCarlo.seed === 'number' ? t('log.seedSuffix', Math.trunc(monteCarlo.seed)) : '',
	));
}

function setWorstCaseObjective(objective: WorstCaseObjective | null) {
	currentWorstCaseObjective = objective;
	worstCaseController.setObjective(objective);
}

function normalizeWorstCaseObjective(
	analysis: Extract<AnalysisPayload, { type: 'worst-case' }>,
): WorstCaseObjective {
	return {
		measurementId: analysis.objective.measurementId,
		label: analysis.objective.label || analysis.objective.measurementId,
		...(analysis.objective.unit ? { unit: analysis.objective.unit } : {}),
	};
}

async function runCurrentNetlist(trigger: 'manual' | 'eda-auto') {
	if (runningSimulation) {
		appendLog(t('log.runningIgnored'));
		return;
	}

	const netlist = netlistInput.value;
	if (!netlist.trim()) {
		appendLog(t('log.emptyNetlist'));
		return;
	}

	mcAbortController = getAnalysisType() === 'monte-carlo' ? new AbortController() : null;
	const request = buildCurrentAnalysisRequest(netlist);
	if (!request) return;
	prepareAnalysisRun(request, trigger);
	setRunning(true);
	try {
		const execution = await executeAnalysis(request);
		mergeLogs(execution.logs);
		for (const artifact of execution.artifacts) presentAnalysisArtifact(artifact);
		appendExecutionOutcome(execution.analysisType, execution.ok, execution.error, execution.logs);
	}
	catch (error) {
		appendLog(t('log.requestFailed', error instanceof Error ? error.message : String(error)));
	}
	finally {
		setRunning(false);
		mcAbortController = null;
		void refreshEngineStatus();
	}
}

function buildCurrentAnalysisRequest(netlist: string): ProductAnalysisRequest | null {
	const analysisType = getAnalysisType();
	if (analysisType === 'monte-carlo') {
		const sampleCount = readMonteCarloSampleCount();
		if (sampleCount === null) return null;
		return {
			analysisType,
			netlist,
			options: {
				sampleCount,
				seed: readMonteCarloSeed(),
				probeNodes: currentProbeNodes,
				compatMode: currentCompatMode,
				onSampleProgress: (progress) => monteCarloController.onSampleProgress(progress),
				signal: mcAbortController?.signal,
			},
		};
	}
	if (analysisType === 'worst-case') {
		if (!currentWorstCaseObjective) {
			appendLog(t('log.wcConfigMissing'));
			return null;
		}
		return {
			analysisType,
			netlist,
			options: { probeNodes: currentProbeNodes, objective: currentWorstCaseObjective, compatMode: currentCompatMode },
		};
	}
	return { analysisType, netlist, options: { probeNodes: currentProbeNodes, compatMode: currentCompatMode } };
}

/** 解析网表 */
function prepareAnalysisRun(request: ProductAnalysisRequest, trigger: 'manual' | 'eda-auto') {
	clearWaveformOnly();
	clearMonteCarloResults();
	clearWorstCaseResults();
	if (request.analysisType === 'monte-carlo') {
		appendLog(t('log.mcStart', request.options.sampleCount, request.options.seed === undefined ? '' : t('log.seedSuffix', request.options.seed)));
		return;
	}
	if (request.analysisType === 'worst-case') {
		worstCaseController.setObjective(request.options.objective);
		appendLog(t('log.wcStartNetlist'));
		return;
	}
	appendLog(t(trigger === 'eda-auto' ? 'log.autoRunStart' : 'log.runStart'));
	const command = findAnalysisCommand(request.netlist);
	appendLog(t(
		'log.analysisDetected',
		analysisLabel(request.analysisType),
		command ? t('log.commandSuffix', command) : '',
	));
}

const artifactPresenters: Record<ProductAnalysisArtifact['kind'], (artifact: ProductAnalysisArtifact) => void> = {
	waveform: (artifact) => {
		if (artifact.kind !== 'waveform') return;
		// 标准分析分流：逻辑 trace 进逻辑分析图，模拟 trace 进波形图。
		// MC/WC 叠加 dataset 不走这里（waveformController.present 直接处理）。
		if (getAnalysisType() === 'transient' || getAnalysisType() === 'ac' || getAnalysisType() === 'dc') {
			logicController.present(artifact.payload, currentProbeNodes);
			return;
		}
		waveformController.present(artifact.payload);
	},
	'monte-carlo': (artifact) => {
		if (artifact.kind !== 'monte-carlo') return;
		monteCarloController.present(artifact.payload);
	},
	'worst-case': (artifact) => {
		if (artifact.kind !== 'worst-case') return;
		worstCaseController.present(artifact.payload);
	},
};

function presentAnalysisArtifact(artifact: ProductAnalysisArtifact) {
	artifactPresenters[artifact.kind](artifact);
}

function appendExecutionOutcome(analysisType: AnalysisType, ok: boolean, error: string | undefined, logs: string[]) {
	if (!ok) {
		appendLog(analysisUiCatalog[analysisType].failureMessage(outcomeErrorDetail(error, logs)));
		return;
	}
	const successMessage = analysisUiCatalog[analysisType].successMessage?.();
	if (successMessage) appendLog(successMessage);
}

/** 错误详情去重 */
function outcomeErrorDetail(error: string | undefined, logs: string[]): string {
	if (!error) return t('log.unknownError');
	const duplicated = logs.some((line) => line.length >= 12 && (line.includes(error) || error.includes(line)));
	if (duplicated || logs.some(isErrorLevelLogLine)) return t('log.failureSeeAbove');
	return error;
}

/** 执行仿真 */
function scheduleImportedAutoRun(imported: NetlistImportMessage, importKey: string) {
	if (pendingAutoRunImportKey === importKey) return;
	if (lastAutoRunImportKey === importKey && Date.now() - lastAutoRunImportAt < IMPORT_RETRY_DEDUPE_MS) return;
	pendingAutoRunImportKey = importKey;
	appendLog(t('log.edaAutoRun'));
	window.setTimeout(() => {
		if (pendingAutoRunImportKey !== importKey) return;
		pendingAutoRunImportKey = '';
		lastAutoRunImportKey = importKey;
		lastAutoRunImportAt = Date.now();
		if (netlistImportKey(imported) !== lastAppliedImportKey) {
			appendLog(t('log.autoRunCancelled'));
			return;
		}
		void runCurrentNetlist('eda-auto');
	}, 0);
}

function clearWaveformOnly() {
	waveformController.clear();
	logicController.clear();
}

function clearMonteCarloResults() {
	monteCarloController.clear();
}

function clearWorstCaseResults() {
	worstCaseController.clear();
}

async function refreshEngineStatus() {
	const status = await getEngineStatus();
	const mode = status.mode;
	if (mode === lastEngineAvailability) return;
	lastEngineAvailability = mode;
	appendLog(mode === 'missing' ? t('log.engineUnavailable') : t('log.engineReady'));
}

function activePresentationController(): AnalysisPresentationController | null {
	return presentationControllers[getAnalysisType()] ?? null;
}

function activeTraceChoiceController(): AnalysisTraceChoiceController | null {
	const controller = activePresentationController();
	return supportsTraceChoices(controller) ? controller : null;
}

function refreshLocalizedUi() {
	applyTranslations(edaApp);
	document.title = t('app.documentTitle');
	workbench.refreshLocale();
	waveformController.refreshLocale(isStandardAnalysis(getAnalysisType()));
	histogramChart.refreshLocale();
	renderNetlistMeta();
	updateAnalysisMode();
	setRunning(runningSimulation);
	monteCarloController.refreshLocale();
	worstCaseController.refreshLocale();
	logicController.refreshLocale();
	void refreshEngineStatus();
	syncCompatSelect();
}

function updateNetlistMeta(label = '', sampleKey = '') {
	currentNetlistMetaLabel = label;
	currentNetlistMetaSampleKey = sampleKey;
	renderNetlistMeta();
}

function renderNetlistMeta() {
	const lines = netlistInput.value.split(/\r?\n/).filter((line) => line.trim()).length;
	const label = currentNetlistMetaSampleKey
		? t('netlist.sample', currentNetlistMetaSampleKey)
		: currentNetlistMetaLabel;
	const lineLabel = t('netlist.lines', lines);
	netlistMeta.textContent = label ? `${label} · ${lineLabel}` : lines ? lineLabel : t('netlist.notLoaded');
}

function syncCompatSelect() {
	const mode = (currentCompatMode ?? '').trim();
	if (compatModeSelect.value !== mode) compatModeSelect.value = mode;
}

function updateAnalysisMode(force?: AnalysisType) {
	const type = force || getAnalysisType() || detectSpiceCommandType(netlistInput.value);
	analysisModeSelect.value = type;
	analysisModeSelect.title = t('log.analysisDetected', analysisLabel(type), '');
	analysisTypeValue.textContent = analysisLabel(type).toUpperCase();
	updateAnalysisControls();
}

function getAnalysisType(): AnalysisType {
	const value = parseAnalysisType(analysisModeSelect.value);
	if (value) return value;
	return detectSpiceCommandType(netlistInput.value);
}

function updateAnalysisControls() {
	const type = getAnalysisType();
	analysisTypeValue.textContent = analysisLabel(type).toUpperCase();
	runButton.innerHTML = `${iconHtml('run')}${analysisUiCatalog[type].runLabel()}`;
	updateWorstCaseInputMode();
}

function updateWorstCaseInputMode() {
	const type = getAnalysisType();
	const isMonteCarlo = type === 'monte-carlo';
	mcSettingsDockButton.classList.toggle('hidden', !isMonteCarlo);
	if (isMonteCarlo) worstCaseController.setObjective(currentWorstCaseObjective);
	if (!isMonteCarlo && activeInputView === 'mcSettings') activateInputPanel('netlist', false);
}

function activateInputPanel(view: 'netlist' | 'mcSettings', toggleCollapse = true) {
	if (view === 'mcSettings' && getAnalysisType() !== 'monte-carlo') return;
	const isCurrent = activeInputView === view;
	activeInputView = view;
	inputDockButton.classList.toggle('active', view === 'netlist');
	mcSettingsDockButton.classList.toggle('active', view === 'mcSettings');
	netlistInputView.classList.toggle('active', view === 'netlist');
	mcSettingsInputView.classList.toggle('active', view === 'mcSettings');
	if (toggleCollapse && isCurrent) workbench.toggleInputCollapsed();
	else workbench.toggleInputCollapsed(false);
}

function readMonteCarloSampleCount(): number | null {
	const value = Number(mcSampleCountInput.value);
	const sampleCount = Math.trunc(value);
	if (!Number.isFinite(sampleCount) || sampleCount <= 0) {
		appendLog(t('log.invalidSampleCount'));
		mcSampleCountInput.focus();
		return null;
	}
	if (sampleCount > 10000) {
		appendLog(t('log.sampleCountLimit'));
		mcSampleCountInput.focus();
		return null;
	}
	return sampleCount;
}

function readMonteCarloSeed(): number | undefined {
	const raw = mcSeedInput.value.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) ? Math.trunc(value) : undefined;
}

/** hidden 载体 -> 可见输入框（EDA 赋值/清空后同步显示）。 */
function syncMcSettingsInputs() {
	mcSampleCountVisible.value = mcSampleCountInput.value;
	mcSeedVisible.value = mcSeedInput.value;
	mcSampleCountVisible.setAttribute('aria-invalid', 'false');
	mcSeedVisible.setAttribute('aria-invalid', 'false');
}

/** MC 设置整数值校验：正整数且在范围内；空串由调用方按"留空"语义处理。 */
function isValidMcInteger(raw: string, min: number, max: number): boolean {
	if (!/^\d+$/.test(raw.trim())) return false;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value >= min && value <= max;
}

function setRunning(running: boolean) {
	runningSimulation = running;
	const analysisType = getAnalysisType();
	// MC 运行中：运行按钮变为"停止"（可点击）；其余分析运行中仍禁用。
	const mcStopButton = running && analysisType === 'monte-carlo' && mcAbortController !== null;
	runButton.disabled = running && !mcStopButton;
	analysisModeSelect.disabled = running;
	mcSampleCountInput.disabled = running;
	mcSeedInput.disabled = running;
	monteCarloController.setRunning(running);
	worstCaseController.setRunning(running);
	waveformController.setRunning(running);
	logicController.setRunning(running);
	runButton.classList.toggle('loading', running);
	runButton.innerHTML = running
		? (mcStopButton
			? `<span class="spinner"></span>${t('action.stop')}`
			: `<span class="spinner"></span>${analysisUiCatalog[analysisType].runningLabel()}`)
		: `${iconHtml('run')}${analysisUiCatalog[analysisType].runLabel()}`;
}

function appendLog(line: string, level: LogLevel = 'plugin') {
	const time = new Date().toLocaleTimeString(getNumberLocale(), { hour12: false });
	logLines.push({ text: `[${time}] ${line}`, level });
	logLines = logLines.slice(-500);
	renderLogs();
}

/** 引擎/runner 侧日志的错误级判定：红色高亮，outcome 行据此决定是否重复错误详情。 */
function isErrorLevelLogLine(line: string): boolean {
	return /^error[: ]/i.test(line) || /fatal|exited unexpectedly|failed to load/i.test(line);
}

/** 引擎/runner 侧日志分级：warning/error 按前缀升级 */
function classifyEngineLog(line: string): LogLevel {
	if (/^warning[: ]/i.test(line)) return 'warn';
	if (isErrorLevelLogLine(line)) return 'error';
	return 'ngspice';
}

function mergeLogs(lines: string[]) {
	for (const line of lines) appendLog(line, classifyEngineLog(line));
}

function renderLogs() {
	logOutput.innerHTML = logLines
		.map((entry) => `<span class="log-line log-line--${entry.level}">${escapeHtml(entry.text)}</span>`)
		.join('\n');
	logOutput.scrollTop = logOutput.scrollHeight;
}

function query<T extends Element>(selector: string): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`Missing element: ${selector}`);
	return el;
}