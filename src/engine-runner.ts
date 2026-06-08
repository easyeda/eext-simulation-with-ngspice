import type { EdaProbeNode, SimulationResponse } from './shared/types';
import { isWasmNgspiceAvailable, runNgspiceNetlistWithWasm } from './wasm-ngspice-runner';

const WASM_BASE_URL = '/iframe/wasm';

export interface RunnerStatus {
	wasmAvailable: boolean;
	nativeConnected: false;
	mode: 'wasm' | 'missing';
	label: string;
}

export interface RunNgspiceOptions {
	probeNodes?: EdaProbeNode[];
}

export async function runNgspiceNetlist(netlist: string, options: RunNgspiceOptions = {}): Promise<SimulationResponse> {
	if (!netlist.trim()) {
		return { ok: false, logs: ['网表内容为空'], error: '网表内容为空' };
	}

	const logs: string[] = ['运行策略: 使用插件内置 ngspice WASM，不下载或启动本地引擎'];
	const wasmResponse = await runNgspiceNetlistWithWasm(netlist, {
		wasmBaseUrl: WASM_BASE_URL,
		timeoutMs: 60_000,
		probeNodes: options.probeNodes,
	});

	if (wasmResponse.ok) {
		return {
			...wasmResponse,
			logs: trimLogs([...logs, ...wasmResponse.logs]),
		};
	}

	return {
		ok: false,
		logs: trimLogs([...logs, ...wasmResponse.logs]),
		error: `内置 WASM 仿真失败: ${wasmResponse.error || '未知错误'}`,
	};
}

export async function getEngineStatus(): Promise<RunnerStatus> {
	const wasmAvailable = isWasmNgspiceAvailable();
	return {
		wasmAvailable,
		nativeConnected: false,
		mode: wasmAvailable ? 'wasm' : 'missing',
		label: wasmAvailable ? 'WASM 已就绪' : 'WASM 准备中',
	};
}

function trimLogs(logs: string[]): string[] {
	return logs.filter(Boolean).slice(-500);
}
