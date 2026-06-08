import { NETLIST_TOPIC, REQUEST_NETLIST_TOPIC, type NetlistImportMessage } from './messages';
import { getEngineStatus, runNgspiceNetlist } from './engine-runner';
import { detectAnalysisType, findAnalysisCommand } from './shared/netlist';
import { normalizeEdaProbeNodes } from './shared/probes';
import type { AnalysisType, EdaProbeNode, SimulationResult, WaveformDataset, WaveformTrace } from './shared/types';
import { WaveformChart, traceColorAt } from './shared/waveform-chart';

declare const eda: any;

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('App root not found');

app.innerHTML = `
  <div class="eda-app" data-theme="light">
    <header class="top-bar">
      <div class="brand-block">
        <span class="brand-mark" aria-hidden="true"></span>
        <div>
          <div class="app-title">NGspice 波形仿真</div>
          <div class="app-subtitle">嘉立创 EDA 仿真网表运行与 transient / AC / DC 查看</div>
        </div>
      </div>
      <div class="toolbar">
        <label class="eda-button default file-button" title="导入本地 TXT 网表">
          <input id="fileInput" type="file" accept=".txt,.cir,.net,.spice" />
          <span class="icon import-icon"></span>
          导入 TXT
        </label>
        <select id="sampleSelect" class="eda-select" title="载入示例网表">
          <option value="">示例网表</option>
          <option value="transient">Transient RC</option>
          <option value="ac">AC RC</option>
          <option value="dc">DC Divider</option>
        </select>
        <label class="mode-control" title="根据网表中的 .tran / .ac / .dc 自动识别">
          <span>模式</span>
          <select id="analysisModeSelect" class="eda-select" disabled>
            <option value="transient">瞬态</option>
            <option value="ac">AC</option>
            <option value="dc">DC</option>
          </select>
        </label>
        <button id="runButton" class="eda-button primary" type="button" title="连接本地引擎并运行">
          <span class="icon run-icon"></span>
          运行
        </button>
        <button id="clearButton" class="eda-button default" type="button" title="清空输入和波形">
          <span class="icon clear-icon"></span>
          清空
        </button>
        <span id="engineStatus" class="status-pill muted">检测引擎...</span>
      </div>
    </header>

    <main class="workbench">
      <section class="input-panel">
        <div class="panel-head">
          <div>
            <h2>NGspice 仿真网表</h2>
            <p>由 EDA 仿真事件导入，或手动导入 / 粘贴纯文本网表</p>
          </div>
          <span id="netlistMeta" class="eda-tag neutral">未载入</span>
        </div>
        <textarea id="netlistInput" class="netlist-editor" spellcheck="false" placeholder="等待 EDA 仿真事件导入网表，或粘贴 .tran / .ac / .dc 网表"></textarea>
      </section>

      <section class="wave-panel">
        <div id="resultTabs" class="result-tabs"></div>
        <article class="chart-card">
          <div class="chart-head">
            <h2 id="chartTitle">NGspice 波形结果</h2>
            <div class="head-actions">
              <div id="chartBadges" class="badges"></div>
              <button id="fitButton" class="tool-button" type="button" title="适应窗口">
                <span class="icon fit-icon"></span>
                适应
              </button>
              <button id="traceSelectButton" class="tool-button" type="button" title="选择显示波形">
                <span class="icon select-icon"></span>
                曲线
              </button>
              <button id="displayButton" class="tool-button active" type="button" title="切换线/点显示">
                <span class="icon trace-icon"></span>
                显示：<span id="displayLabel">仅线</span>
              </button>
              <button id="expandButton" class="tool-button" type="button" title="单独放大波形">
                <span class="icon expand-icon"></span>
                放大
              </button>
            </div>
          </div>
          <div class="plot-shell">
            <div id="chart"></div>
          </div>
        </article>
      </section>
    </main>

    <section class="log-panel">
      <div class="log-head">
        <div>
          <h2>运行日志</h2>
          <p>导入、连接、stdout / stderr 与错误信息</p>
        </div>
        <button id="clearLogButton" class="eda-button default compact" type="button">清空日志</button>
      </div>
      <pre id="logOutput" class="log-output"></pre>
    </section>

    <div id="traceDialog" class="modal-mask hidden" role="dialog" aria-modal="true">
      <div class="lc-modal trace-dialog">
        <div class="lc-modal__header">
          <h2>选择显示波形</h2>
          <button id="closeTraceDialog" class="modal-close" type="button" title="关闭">×</button>
        </div>
        <div class="lc-modal__body">
          <div class="trace-dialog-toolbar">
            <input id="traceFilterInput" class="trace-filter-input" type="search" placeholder="筛选曲线名" aria-label="筛选曲线名" />
            <span id="traceCount" class="eda-tag neutral">0/0 已选</span>
            <button id="traceAllButton" class="eda-button default compact" type="button">全选</button>
            <button id="traceClearButton" class="eda-button default compact" type="button">清空</button>
            <button id="traceInvertButton" class="eda-button default compact" type="button">反选</button>
          </div>
          <div id="traceList" class="trace-list"></div>
        </div>
        <div class="lc-modal__footer">
          <button id="traceCancelButton" class="eda-button default" type="button">取消</button>
          <button id="traceApplyButton" class="eda-button primary" type="button">显示选中</button>
        </div>
      </div>
    </div>
  </div>
`;

const edaApp = query<HTMLElement>('.eda-app');
const fileInput = query<HTMLInputElement>('#fileInput');
const sampleSelect = query<HTMLSelectElement>('#sampleSelect');
const analysisModeSelect = query<HTMLSelectElement>('#analysisModeSelect');
const runButton = query<HTMLButtonElement>('#runButton');
const clearButton = query<HTMLButtonElement>('#clearButton');
const clearLogButton = query<HTMLButtonElement>('#clearLogButton');
const netlistInput = query<HTMLTextAreaElement>('#netlistInput');
const netlistMeta = query<HTMLElement>('#netlistMeta');
const engineStatus = query<HTMLElement>('#engineStatus');
const logOutput = query<HTMLPreElement>('#logOutput');
const resultTabs = query<HTMLElement>('#resultTabs');
const fitButton = query<HTMLButtonElement>('#fitButton');
const traceSelectButton = query<HTMLButtonElement>('#traceSelectButton');
const displayButton = query<HTMLButtonElement>('#displayButton');
const displayLabel = query<HTMLElement>('#displayLabel');
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

const chart = new WaveformChart(
	query<HTMLElement>('#chart'),
	query<HTMLElement>('#chartTitle'),
	query<HTMLElement>('#chartBadges'),
);

let currentResult: SimulationResult | null = null;
let activeDatasetId: string | null = null;
let traceSelection = new Map<string, Set<string>>();
let dialogDataset: WaveformDataset | null = null;
let dialogSelectedTraceIds = new Set<string>();
let logLines: string[] = [];
let currentProbeNodes: EdaProbeNode[] = [];
let lastAppliedImportKey = '';
let runningSimulation = false;

appendLog('界面已就绪。运行时使用插件内置 NGspice WASM，不会下载或启动本地引擎。');
updateAnalysisMode();
void refreshEngineStatus();
subscribeToEdaNetlist();

fileInput.addEventListener('change', async () => {
	const file = fileInput.files?.[0];
	if (!file) return;
	netlistInput.value = await file.text();
	sampleSelect.value = '';
	currentProbeNodes = [];
	updateNetlistMeta(file.name);
	updateAnalysisMode();
	clearWaveformOnly();
	appendLog(`已导入本地文件: ${file.name}`);
});

sampleSelect.addEventListener('change', () => {
	const key = sampleSelect.value as keyof typeof sampleNetlists | '';
	if (!key) return;
	netlistInput.value = sampleNetlists[key];
	currentProbeNodes = [];
	updateNetlistMeta(`示例: ${key}`);
	updateAnalysisMode();
	clearWaveformOnly();
	appendLog(`已载入示例网表: ${key}`);
});

netlistInput.addEventListener('input', () => {
	currentProbeNodes = [];
	updateNetlistMeta();
	updateAnalysisMode();
});

runButton.addEventListener('click', () => {
	void runCurrentNetlist('manual');
});

clearButton.addEventListener('click', () => {
	netlistInput.value = '';
	sampleSelect.value = '';
	clearWaveformOnly();
	updateAnalysisMode();
	updateNetlistMeta();
	appendLog('已清空输入和波形');
});

clearLogButton.addEventListener('click', () => {
	logLines = [];
	renderLogs();
});

fitButton.addEventListener('click', () => chart.fit());
traceSelectButton.addEventListener('click', () => showTraceDialog());
displayButton.addEventListener('click', () => {
	displayLabel.textContent = chart.cycleDisplayMode();
});
expandButton.addEventListener('click', () => toggleWaveExpanded());
closeTraceDialog.addEventListener('click', closeTraceSelectionDialog);
traceCancelButton.addEventListener('click', closeTraceSelectionDialog);
traceAllButton.addEventListener('click', () => setDialogChecks('all'));
traceClearButton.addEventListener('click', () => setDialogChecks('none'));
traceInvertButton.addEventListener('click', () => setDialogChecks('invert'));
traceApplyButton.addEventListener('click', applyTraceSelectionFromDialog);
traceDialog.addEventListener('mousedown', (event) => {
	if (event.target === traceDialog) closeTraceSelectionDialog();
});
traceFilterInput.addEventListener('input', renderTraceDialogList);
document.addEventListener('keydown', (event) => {
	if (event.key !== 'Escape') return;
	if (!traceDialog.classList.contains('hidden')) {
		closeTraceSelectionDialog();
		return;
	}
	if (edaApp.classList.contains('wave-expanded')) toggleWaveExpanded(false);
});

function subscribeToEdaNetlist() {
	const bus = getMessageBus();
	if (!bus) {
		appendLog('未检测到 EDA 消息总线，当前为独立预览模式');
		return;
	}

	try {
		bus.subscribePublic(NETLIST_TOPIC, (message: unknown) => {
			if (isNetlistMessage(message)) {
				appendLog(`收到网表广播: ${message.fileName}，探针 ${message.probeNodes?.length ?? 0} 个`);
				applyImportedNetlist(message);
			}
		});
		bus.rpcCallPublic(REQUEST_NETLIST_TOPIC, undefined, 800).then((message: unknown) => {
			if (isNetlistMessage(message)) {
				appendLog(`RPC 拉取到最近网表: ${message.fileName}，探针 ${message.probeNodes?.length ?? 0} 个`);
				applyImportedNetlist(message);
			}
		}).catch(() => {
			// 首次打开时可能还没有从 EDA 导出过网表。
		});
		appendLog('已连接 EDA 消息总线，等待当前原理图仿真网表');
	}
	catch (error) {
		appendLog(`消息总线连接失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function applyImportedNetlist(imported: NetlistImportMessage) {
	const importKey = netlistImportKey(imported);
	if (importKey === lastAppliedImportKey) {
		appendLog(`跳过重复网表消息: ${imported.fileName}`);
		return;
	}
	lastAppliedImportKey = importKey;
	netlistInput.value = imported.netlist;
	sampleSelect.value = '';
	currentProbeNodes = normalizeEdaProbeNodes(imported.probeNodes);
	clearWaveformOnly();
	updateAnalysisMode(imported.analysisType);
	if (currentProbeNodes.length) appendLog(`已接收 EDA 探针 ${currentProbeNodes.length} 个，将作为默认显示曲线`);
	updateNetlistMeta(`${imported.fileName} · ${analysisModeLabel(imported.analysisType)}`);
	appendLog(`已从 ${imported.source} 导入仿真网表: ${imported.fileName}`);
	appendLog(`识别模式: ${analysisModeLabel(imported.analysisType)}${imported.command ? `，命令: ${imported.command}` : ''}`);
	if (imported.autoRun) {
		appendLog('EDA 仿真事件已导入网表，自动开始仿真');
		void runCurrentNetlist('eda-auto');
	}
}

function netlistImportKey(imported: NetlistImportMessage): string {
	return [
		imported.importedAt,
		imported.fileName,
		imported.lineCount,
		imported.command,
		imported.netlist.length,
		JSON.stringify(normalizeEdaProbeNodes(imported.probeNodes)),
		imported.autoRun ? 'auto' : 'manual',
	].join('|');
}

async function runCurrentNetlist(trigger: 'manual' | 'eda-auto') {
	if (runningSimulation) {
		appendLog('仿真正在运行，已忽略新的运行请求');
		return;
	}

	const netlist = netlistInput.value;
	if (!netlist.trim()) {
		appendLog('网表内容为空，无法运行');
		return;
	}

	setRunning(true);
	appendLog(trigger === 'eda-auto' ? '开始自动运行 EDA 仿真...' : '开始运行仿真...');
	appendLog(`识别模式: ${analysisModeLabel(detectAnalysisType(netlist))}${findAnalysisCommand(netlist) ? `，命令: ${findAnalysisCommand(netlist)}` : ''}`);
	try {
		const response = await runNgspiceNetlist(netlist, { probeNodes: currentProbeNodes });
		mergeLogs(response.logs);
		if (!response.ok || !response.result) {
			appendLog(`仿真失败: ${response.error || '未知错误'}`);
			return;
		}
		currentResult = response.result;
		initializeTraceSelections(response.result);
		renderResultTabs();
		activateDataset(response.result.activeDatasetId || response.result.datasets[0]?.id || '');
		appendLog('仿真完成，波形已更新');
	}
	catch (error) {
		appendLog(`请求失败: ${error instanceof Error ? error.message : String(error)}`);
	}
	finally {
		setRunning(false);
		queueTraceDialogOpen();
		void refreshEngineStatus();
	}
}

function renderResultTabs() {
	if (!currentResult || currentResult.datasets.length <= 1) {
		resultTabs.innerHTML = '';
		return;
	}

	resultTabs.innerHTML = currentResult.datasets.map((dataset) => `
    <button class="result-tab" type="button" data-id="${dataset.id}">
      ${escapeHtml(dataset.analysisType.toUpperCase())}
      <span>${escapeHtml(dataset.meta.sourcePlot || dataset.command || dataset.id)}</span>
    </button>
  `).join('');

	resultTabs.querySelectorAll<HTMLButtonElement>('.result-tab').forEach((button) => {
		button.addEventListener('click', () => activateDataset(button.dataset.id || ''));
	});
}

function activateDataset(id: string) {
	if (!currentResult) return;
	const dataset = currentResult.datasets.find((item) => item.id === id) || currentResult.datasets[0] || null;
	activeDatasetId = dataset?.id || null;
	const selected = dataset ? ensureTraceSelection(dataset) : null;
	chart.setVisibleTraceIds(selected, false);
	chart.setDataset(dataset);
	displayLabel.textContent = chart.getDisplayLabel();
	resultTabs.querySelectorAll<HTMLElement>('.result-tab').forEach((tab) => {
		tab.classList.toggle('active', tab.dataset.id === dataset?.id);
	});
}

function clearWaveformOnly() {
	currentResult = null;
	activeDatasetId = null;
	traceSelection = new Map<string, Set<string>>();
	resultTabs.innerHTML = '';
	closeTraceSelectionDialog();
	chart.setDataset(null);
}

function initializeTraceSelections(result: SimulationResult) {
	traceSelection = new Map<string, Set<string>>();
	for (const dataset of result.datasets) {
		traceSelection.set(dataset.id, defaultTraceSelection(dataset, result));
	}
}

function defaultTraceSelection(dataset: WaveformDataset, result = currentResult): Set<string> {
	const preferred = result?.preferredTraceIdsByDataset?.[dataset.id]?.filter((id) => dataset.traces.some((trace) => trace.id === id));
	if (preferred?.length) return new Set(preferred);
	if (dataset.traces.length <= 6) return new Set(dataset.traces.map((trace) => trace.id));
	return new Set(dataset.traces.slice(0, 6).map((trace) => trace.id));
}

function ensureTraceSelection(dataset: WaveformDataset): Set<string> {
	const existing = traceSelection.get(dataset.id);
	if (existing) return existing;
	const next = defaultTraceSelection(dataset);
	traceSelection.set(dataset.id, next);
	return next;
}

function showTraceDialog(datasetId = activeDatasetId || undefined) {
	if (!currentResult) {
		appendLog('暂无仿真结果，无法选择波形');
		return;
	}
	const dataset = currentResult.datasets.find((item) => item.id === datasetId) || currentResult.datasets[0];
	if (!dataset) return;
	activeDatasetId = dataset.id;
	const selected = ensureTraceSelection(dataset);
	dialogDataset = dataset;
	dialogSelectedTraceIds = new Set(selected);
	traceFilterInput.value = '';
	renderTraceDialogList();
	traceDialog.classList.remove('hidden');
	traceFilterInput.focus();
}

function renderTraceDialogList() {
	if (!dialogDataset) return;
	const dataset = dialogDataset;
	const traces = getDialogVisibleTraces();
	traceList.innerHTML = traces.length ? traces.map((trace) => {
		const traceIndex = dataset.traces.findIndex((item) => item.id === trace.id);
		const color = trace.color || traceColorAt(traceIndex);
		return `
    <label class="trace-option">
      <input type="checkbox" value="${escapeHtml(trace.id)}" ${dialogSelectedTraceIds.has(trace.id) ? 'checked' : ''} />
      <span class="trace-swatch" style="--trace-color:${escapeHtml(color)}"></span>
      <span class="trace-name">${escapeHtml(trace.name)}</span>
      <span class="trace-meta">${escapeHtml(trace.unit)} · ${formatInteger(trace.points.length)} 采样点</span>
    </label>
  `;
	}).join('') : '<div class="trace-empty">无匹配曲线</div>';
	traceList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach((input) => {
		input.addEventListener('change', () => {
			if (input.checked) dialogSelectedTraceIds.add(input.value);
			else dialogSelectedTraceIds.delete(input.value);
			updateTraceDialogCount();
		});
	});
	updateTraceDialogCount();
}

function closeTraceSelectionDialog() {
	traceDialog.classList.add('hidden');
	dialogDataset = null;
	dialogSelectedTraceIds = new Set<string>();
}

function setDialogChecks(mode: 'all' | 'none' | 'invert') {
	for (const trace of getDialogVisibleTraces()) {
		if (mode === 'all') dialogSelectedTraceIds.add(trace.id);
		if (mode === 'none') dialogSelectedTraceIds.delete(trace.id);
		if (mode === 'invert') {
			if (dialogSelectedTraceIds.has(trace.id)) dialogSelectedTraceIds.delete(trace.id);
			else dialogSelectedTraceIds.add(trace.id);
		}
	}
	renderTraceDialogList();
}

function applyTraceSelectionFromDialog() {
	if (!currentResult || !activeDatasetId) return;
	const checked = [...dialogSelectedTraceIds];
	if (!checked.length) {
		appendLog('至少选择一条波形后再显示');
		return;
	}
	traceSelection.set(activeDatasetId, new Set(checked));
	chart.setVisibleTraceIds(checked, true);
	closeTraceSelectionDialog();
	appendLog(`已选择 ${checked.length} 条波形显示`);
}

function updateTraceDialogCount() {
	if (!dialogDataset) {
		traceCount.textContent = '0/0 已选';
		traceApplyButton.disabled = true;
		return;
	}
	const visibleCount = getDialogVisibleTraces().length;
	const selectedCount = dialogSelectedTraceIds.size;
	const totalCount = dialogDataset.traces.length;
	const hasFilter = Boolean(traceFilterInput.value.trim());
	traceCount.textContent = hasFilter
		? `${selectedCount}/${totalCount} 已选 · ${visibleCount} 匹配`
		: `${selectedCount}/${totalCount} 已选`;
	traceApplyButton.disabled = selectedCount === 0;
}

function getDialogVisibleTraces(): WaveformTrace[] {
	if (!dialogDataset) return [];
	const keyword = traceFilterInput.value.trim().toLowerCase();
	if (!keyword) return dialogDataset.traces;
	return dialogDataset.traces.filter((trace) => `${trace.name} ${trace.unit} ${trace.id}`.toLowerCase().includes(keyword));
}

function toggleWaveExpanded(force?: boolean) {
	const shouldExpand = typeof force === 'boolean' ? force : !edaApp.classList.contains('wave-expanded');
	edaApp.classList.toggle('wave-expanded', shouldExpand);
	expandButton.innerHTML = shouldExpand
		? '<span class="icon collapse-icon"></span>还原'
		: '<span class="icon expand-icon"></span>放大';
	window.setTimeout(() => chart.resize(), 30);
	window.setTimeout(() => chart.resize(), 180);
}

async function refreshEngineStatus() {
	const status = await getEngineStatus();
	engineStatus.textContent = status.label;
	engineStatus.className = `status-pill ${status.mode === 'missing' ? 'warn' : 'ok'}`;
}

function updateNetlistMeta(label = '') {
	const lines = netlistInput.value.split(/\r?\n/).filter((line) => line.trim()).length;
	netlistMeta.textContent = label ? `${label} · ${lines} 行` : lines ? `${lines} 行` : '未载入';
}

function updateAnalysisMode(force?: AnalysisType) {
	const type = force || detectAnalysisType(netlistInput.value);
	analysisModeSelect.value = type;
	analysisModeSelect.title = `识别模式：${analysisModeLabel(type)}`;
}

function analysisModeLabel(type: AnalysisType): string {
	if (type === 'ac') return 'AC';
	if (type === 'dc') return 'DC';
	return '瞬态';
}

function setRunning(running: boolean) {
	runningSimulation = running;
	runButton.disabled = running;
	runButton.classList.toggle('loading', running);
	runButton.innerHTML = running
		? '<span class="spinner"></span>运行中'
		: '<span class="icon run-icon"></span>运行';
}

function queueTraceDialogOpen() {
	if (!currentResult || runningSimulation) return;
	const open = () => {
		if (!currentResult || runningSimulation) return;
		showTraceDialog();
		chart.resize();
	};
	if (typeof requestAnimationFrame === 'function') {
		requestAnimationFrame(() => requestAnimationFrame(open));
		return;
	}
	window.setTimeout(open, 30);
}

function appendLog(line: string) {
	const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
	logLines.push(`[${time}] ${line}`);
	logLines = logLines.slice(-500);
	renderLogs();
}

function mergeLogs(lines: string[]) {
	for (const line of lines) appendLog(line);
}

function renderLogs() {
	logOutput.textContent = logLines.join('\n');
	logOutput.scrollTop = logOutput.scrollHeight;
}

function getMessageBus(): any | null {
	try {
		if (typeof eda !== 'undefined' && eda?.sys_MessageBus) return eda.sys_MessageBus;
	}
	catch {
		// ignored
	}
	try {
		const parentEda = window.parent && (window.parent as any).eda;
		return parentEda?.sys_MessageBus || null;
	}
	catch {
		return null;
	}
}

function isNetlistMessage(value: unknown): value is NetlistImportMessage {
	if (!value || typeof value !== 'object') return false;
	const record = value as Record<string, unknown>;
	return record.type === 'simulation-netlist' && typeof record.netlist === 'string';
}

function query<T extends Element>(selector: string): T {
	const el = document.querySelector<T>(selector);
	if (!el) throw new Error(`Missing element: ${selector}`);
	return el;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		'\'': '&#39;',
	}[char] || char));
}

function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString('zh-CN') : '0';
}

const sampleNetlists = {
	transient: `* Transient RC sample
V1 in 0 PULSE(0 5 0 1n 1n 1m 2m)
R1 in out 1k
C1 out 0 1u
.tran 10u 8m
.save v(in) v(out)
.end`,
	ac: `* AC RC low-pass sample
V1 in 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 40 10 1Meg
.save v(out)
.end`,
	dc: `* DC divider sample
V1 in 0 0
R1 in out 1k
R2 out 0 1k
.dc V1 0 5 0.05
.save v(out)
.end`,
};
