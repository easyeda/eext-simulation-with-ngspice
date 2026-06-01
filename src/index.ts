import { INSTALL_LAUNCHER_TOPIC, LAUNCH_ENGINE_TOPIC, NETLIST_TOPIC, REQUEST_NETLIST_TOPIC, type NetlistImportMessage } from './messages';
import { detectAnalysisType, findAnalysisCommand } from './shared/netlist';
import JSZip from 'jszip';

declare const eda: any;
declare const ESCH_SimulationNetlistType: { NGSPICE?: unknown } | undefined;

let latestNetlistMessage: NetlistImportMessage | null = null;
let rpcRegistered = false;

export function activate(): void {
	registerNetlistRpc();
}

export async function openWaveformPanel(): Promise<void> {
	registerNetlistRpc();
	await openPanel();
	publishLatestLater();
}

export async function importSimulationNetlistToWaveform(): Promise<void> {
	registerNetlistRpc();
	try {
		await openPanel();
		const file = await eda.sch_ManufactureData.getSimulationNetlistFile(
			'simulation-netlist',
			resolveNgspiceNetlistType(),
		);

		if (!file) {
			showInfo('当前原理图没有可导出的 NGspice 仿真网表。请先确认原理图中包含仿真源、分析命令和可仿真模型。', 'NGspice 波形仿真');
			return;
		}

		const netlist = await file.text();
		if (!netlist.trim()) {
			showInfo('导出的仿真网表为空，无法运行。', 'NGspice 波形仿真');
			return;
		}

		const analysisType = detectAnalysisType(netlist);
		latestNetlistMessage = {
			type: 'simulation-netlist',
			source: 'EasyEDA Pro',
			fileName: normalizeFileName(file.name || 'simulation-netlist.cir'),
			netlist,
			analysisType,
			command: findAnalysisCommand(netlist),
			lineCount: countLines(netlist),
			importedAt: Date.now(),
		};

		publishLatestLater();
		showToast(`已导出 ${latestNetlistMessage.fileName}，${latestNetlistMessage.lineCount} 行`);
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		showInfo(`导出或打开波形界面失败：${message}`, 'NGspice 波形仿真');
	}
}

async function openPanel(): Promise<void> {
	await eda.sys_IFrame.openIFrame('/iframe/index.html', 1280, 820, 'jlc-ngspice-waveform-panel', {
		maximizeButton: true,
		minimizeButton: true,
		title: 'NGspice 波形仿真',
	});
}

function registerNetlistRpc() {
	if (rpcRegistered) return;
	rpcRegistered = true;
	try {
		eda.sys_MessageBus.rpcServicePublic(REQUEST_NETLIST_TOPIC, () => latestNetlistMessage);
		eda.sys_MessageBus.rpcServicePublic(LAUNCH_ENGINE_TOPIC, () => launchLocalEngine());
		eda.sys_MessageBus.rpcServicePublic(INSTALL_LAUNCHER_TOPIC, () => installLauncher());
	}
	catch {
		rpcRegistered = false;
	}
}

function publishLatestLater() {
	if (!latestNetlistMessage) return;
	for (const delay of [120, 420, 900, 1600]) {
		schedule(() => {
			try {
				eda.sys_MessageBus.publishPublic(NETLIST_TOPIC, latestNetlistMessage);
			}
			catch {
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

function resolveNgspiceNetlistType(): unknown {
	if (typeof ESCH_SimulationNetlistType !== 'undefined' && ESCH_SimulationNetlistType?.NGSPICE) {
		return ESCH_SimulationNetlistType.NGSPICE;
	}
	return 'NGspice';
}

function normalizeFileName(fileName: string): string {
	const trimmed = fileName.trim() || 'simulation-netlist.cir';
	return /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.cir`;
}

function countLines(text: string): number {
	return text.split(/\r?\n/).filter((line) => line.trim()).length;
}

function showInfo(content: string, title: string) {
	try {
		eda.sys_Dialog.showInformationMessage(content, title, '确定');
	}
	catch {
		console.log(`[${title}] ${content}`);
	}
}

function showToast(content: string) {
	try {
		eda.sys_Message.showToastMessage(content, 'success');
	}
	catch {
		console.log(content);
	}
}
