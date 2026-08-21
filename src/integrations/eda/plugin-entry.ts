import {
	NETLIST_TOPIC,
	REQUEST_NETLIST_TOPIC,
	type NetlistImportMessage,
} from './messages';
import { initializeI18n, t } from '../../shared/i18n';
import { adaptSimulationEvent } from './simulation-event-adapter';
import { resolveEdaHost, resolveMessageBus } from './host';

let latestNetlistMessage: NetlistImportMessage | null = null;
let rpcRegistered = false;
let simulationEventRegistered = false;

function debugLog(message: string, extra?: unknown): void {
	try {
		if (extra !== undefined) console.log(`[ngspice-waveform] ${message}`, extra);
		else console.log(`[ngspice-waveform] ${message}`);
	}
	catch {
		// 某些扩展宿主阶段可能无法使用 Console。
	}
}

enum SpicePullEventType {
	SIMULATE_NETLIST = 'SIMULATE_NETLIST',
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	debugLog('activate called', { status, arg });
	void initializeI18n();
	registerNetlistRpc();
	if (!status || status === 'onStartupFinished') {
		registerSimulationEngineEvents();
	}
}

export async function openWaveformPanel(): Promise<void> {
	debugLog('openWaveformPanel called');
	latestNetlistMessage = null;
	await openPanel();
}

async function openPanel(): Promise<void> {
	debugLog('opening iframe panel');
	await initializeI18n();
	const iframe = resolveEdaHost()?.sys_IFrame;
	if (!iframe || typeof iframe.openIFrame !== 'function') {
		throw new Error('EasyEDA iframe API is unavailable');
	}
	await iframe.openIFrame('/iframe/index.html', 1280, 820, 'jlc-ngspice-waveform-panel', {
		maximizeButton: true,
		minimizeButton: true,
		title: t('app.windowTitle'),
	});
}

function registerNetlistRpc() {
	if (rpcRegistered) {
		debugLog('MessageBus RPC already registered');
		return;
	}
	rpcRegistered = true;
	try {
		const bus = resolveMessageBus();
		if (!bus) throw new Error('EasyEDA MessageBus API is unavailable');
		bus.rpcServicePublic(REQUEST_NETLIST_TOPIC, () => latestNetlistMessage);
		debugLog('MessageBus RPC registered');
	}
	catch (error) {
		rpcRegistered = false;
		debugLog('MessageBus RPC register failed', error instanceof Error ? error.message : String(error));
	}
}

function registerSimulationEngineEvents() {
	if (simulationEventRegistered) {
		debugLog('simulation engine listener already registered');
		return;
	}
	const simulationEvents = resolveEdaHost()?.sch_Event;
	if (!simulationEvents || typeof simulationEvents.addSimulationEnginePullEventListener !== 'function') {
		debugLog('simulation engine listener API unavailable');
		return;
	}
	simulationEventRegistered = true;
	try {
		simulationEvents.addSimulationEnginePullEventListener('jlc-ngspice-waveform-engine', 'all', async (eventType: string, props: unknown) => {
			const record = props && typeof props === 'object' ? props as Record<string, unknown> : {};
			debugLog('simulation engine event received', {
				eventType,
				hasNetlist: typeof record.netlist === 'string',
				probeCount: Array.isArray(record.probeNodes) ? record.probeNodes.length : Array.isArray(record.ProbeNodes) ? record.ProbeNodes.length : 0,
				analysisType: record.analysisType ?? record.simulationMode,
				monteCarlo: record.monteCarlo ?? record.MonteCarlo,
				worstCase: record.worstCase ?? record.WorstCase,
			});
			if (eventType !== SpicePullEventType.SIMULATE_NETLIST) return;
			try {
				await openPanel();
				debugLog('panel opened before simulation netlist import');
			}
			catch (error) {
				debugLog('open panel before simulation netlist import failed or already open', error instanceof Error ? error.message : String(error));
				// 继续导入网表；已经打开的面板仍然可以接收消息。
			}
			await receiveEdaSimulationNetlist(props);
		});
		debugLog('simulation engine listener registered');
	}
	catch (error) {
		simulationEventRegistered = false;
		debugLog('simulation engine listener register failed', error instanceof Error ? error.message : String(error));
	}
}

async function receiveEdaSimulationNetlist(props: unknown): Promise<void> {
	const adapted = adaptSimulationEvent(props);
	if (!adapted.ok) {
		debugLog(`simulation event ignored: ${adapted.error}`);
		return;
	}
	latestNetlistMessage = adapted.message;
	const cachedMessage = latestNetlistMessage;
	debugLog('simulation netlist cached', {
		analysisType: cachedMessage.analysis.type,
		probeCount: cachedMessage.defaultVisibleProbes.length,
		analysis: cachedMessage.analysis,
	});
	publishLatestLater();
}

function publishLatestLater() {
	if (!latestNetlistMessage) {
		debugLog('publish skipped: no latest netlist');
		return;
	}
	debugLog('schedule netlist publish', {
		fileName: latestNetlistMessage.fileName,
		probeCount: latestNetlistMessage.defaultVisibleProbes.length,
	});
	for (const delay of [120, 420, 900, 1600]) {
		schedule(() => {
			try {
				const bus = resolveMessageBus();
				if (!bus) throw new Error('EasyEDA MessageBus API is unavailable');
				bus.publishPublic(NETLIST_TOPIC, latestNetlistMessage);
				debugLog('netlist published', { delay });
			}
			catch (error) {
				debugLog('netlist publish failed', {
					delay,
					error: error instanceof Error ? error.message : String(error),
				});
				// iframe 里还可以通过 RPC 拉取最近一次网表。
			}
		}, delay);
	}
}

function schedule(callback: () => void, delay: number) {
	const timer = globalThis.setTimeout;
	if (typeof timer === 'function') {
		timer(callback, delay);
	}
}
