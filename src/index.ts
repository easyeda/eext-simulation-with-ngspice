import { INSTALL_LAUNCHER_TOPIC, LAUNCH_ENGINE_TOPIC, NETLIST_TOPIC, REQUEST_NETLIST_TOPIC, type NetlistImportMessage } from './messages';
import { detectAnalysisType, findAnalysisCommand } from './shared/netlist';
import { normalizeEdaProbeNodes } from './shared/probes';
import JSZip from 'jszip';

declare const eda: any;

let latestNetlistMessage: NetlistImportMessage | null = null;
let rpcRegistered = false;
let simulationEventRegistered = false;

function debugLog(message: string, extra?: unknown): void {
	try {
		if (extra !== undefined) console.log(`[ngspice-waveform] ${message}`, extra);
		else console.log(`[ngspice-waveform] ${message}`);
	}
	catch {
		// Console may be unavailable in some extension host phases.
	}
}

enum SpicePullEventType {
	SIMULATE_NETLIST = 'SIMULATE_NETLIST',
	VALIDATE_NETLIST = 'VALIDATE_NETLIST',
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	debugLog('activate called', { status, arg });
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
	await eda.sys_IFrame.openIFrame('/iframe/index.html', 1280, 820, 'jlc-ngspice-waveform-panel', {
		maximizeButton: true,
		minimizeButton: true,
		title: 'NGspice 波形仿真',
	});
}

function registerNetlistRpc() {
	if (rpcRegistered) {
		debugLog('MessageBus RPC already registered');
		return;
	}
	rpcRegistered = true;
	try {
		eda.sys_MessageBus.rpcServicePublic(REQUEST_NETLIST_TOPIC, () => latestNetlistMessage);
		eda.sys_MessageBus.rpcServicePublic(LAUNCH_ENGINE_TOPIC, () => launchLocalEngine());
		eda.sys_MessageBus.rpcServicePublic(INSTALL_LAUNCHER_TOPIC, () => installLauncher());
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
	if (typeof eda?.sch_Event?.addSimulationEnginePullEventListener !== 'function') {
		debugLog('simulation engine listener API unavailable');
		return;
	}
	simulationEventRegistered = true;
	try {
		eda.sch_Event.addSimulationEnginePullEventListener('jlc-ngspice-waveform-engine', 'all', async (eventType: SpicePullEventType, props: unknown) => {
			const record = props && typeof props === 'object' ? props as Record<string, unknown> : {};
			debugLog('simulation engine event received', {
				eventType,
				hasNetlist: typeof record.netlist === 'string',
				probeCount: Array.isArray(record.probeNodes) ? record.probeNodes.length : Array.isArray(record.ProbeNodes) ? record.ProbeNodes.length : 0,
			});
			if (eventType !== SpicePullEventType.SIMULATE_NETLIST) return;
			try {
				await openPanel();
				debugLog('panel opened before simulation netlist import');
			}
			catch (error) {
				debugLog('open panel before simulation netlist import failed or already open', error instanceof Error ? error.message : String(error));
				// Continue importing the netlist; an already-open panel can still receive it.
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
	const record = props && typeof props === 'object' ? props as Record<string, unknown> : {};
	const netlist = typeof record.netlist === 'string' ? record.netlist : '';
	const probeNodes = normalizeEdaProbeNodes(record.probeNodes ?? record.ProbeNodes);
	if (!netlist.trim()) {
		debugLog('simulation event ignored: empty netlist');
		return;
	}

	const analysisType = detectAnalysisType(netlist);
	latestNetlistMessage = {
		type: 'simulation-netlist',
		source: 'EasyEDA Pro',
		fileName: 'simulation-netlist.cir',
		netlist,
		analysisType,
		command: findAnalysisCommand(netlist),
		lineCount: countLines(netlist),
		importedAt: Date.now(),
		probeNodes,
		autoRun: true,
	};
	debugLog('simulation netlist cached', {
		lineCount: latestNetlistMessage.lineCount,
		analysisType,
		command: latestNetlistMessage.command,
		probeCount: probeNodes.length,
		autoRun: latestNetlistMessage.autoRun,
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
		lineCount: latestNetlistMessage.lineCount,
		probeCount: latestNetlistMessage.probeNodes?.length ?? 0,
	});
	for (const delay of [120, 420, 900, 1600]) {
		schedule(() => {
			try {
				eda.sys_MessageBus.publishPublic(NETLIST_TOPIC, latestNetlistMessage);
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

function launchLocalEngine(): { ok: boolean; message: string } {
	return {
		ok: false,
		message: '安全模式：已禁止自动打开本地协议，避免宿主浏览器崩溃',
	};
}

async function installLauncher(): Promise<{ ok: boolean; message: string }> {
	try {
		const installFiles = [
			'install-launcher.cmd',
			'install-launch-protocol.ps1',
			'start-jlc-ngspice-engine.ps1',
		];
		const zip = new JSZip();

		for (const fileName of installFiles) {
			const file = await eda.sys_FileSystem.getExtensionFile(`/tools/${fileName}`);
			if (!file) return { ok: false, message: `插件包缺少启动器文件: ${fileName}` };
			zip.file(fileName, await file.arrayBuffer());
		}

		const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
		await eda.sys_FileSystem.saveFile(blob, 'jlc-ngspice-launcher.zip');
		return {
			ok: true,
			message: '已导出 jlc-ngspice-launcher.zip。请解压后双击 install-launcher.cmd 一次，完成注册并启动引擎。',
		};
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			message: `导出本地启动器失败: ${message}`,
		};
	}
}

function schedule(callback: () => void, delay: number) {
	const timer = globalThis.setTimeout;
	if (typeof timer === 'function') {
		timer(callback, delay);
	}
}

function countLines(text: string): number {
	return text.split(/\r?\n/).filter((line) => line.trim()).length;
}
