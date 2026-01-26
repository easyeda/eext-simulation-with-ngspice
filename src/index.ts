import * as extensionConfig from '../extension.json';
import embeddedSideWasmBase64 from '../wasm/libngspice.wasm';
import ngspiceScriptText from '../wasm/ngspice.js?raw';
import embeddedMainWasmBase64 from '../wasm/ngspice.wasm';

const NGSPICE_JS = 'wasm/ngspice.js';
const NGSPICE_MAIN_WASM = 'wasm/ngspice.wasm';
const NGSPICE_SIDE_WASM = 'wasm/libngspice.wasm';
const DEBUG = true;

type CCallReturnType = 'number' | 'string' | 'boolean' | 'array' | 'null' | null;

interface NgspiceModule {
	ccall?: (ident: string, returnType: CCallReturnType, argTypes: string[], args: any[]) => any;
	FS: {
		analyzePath: (path: string) => { exists: boolean };
		mkdir: (path: string) => void;
		writeFile: (path: string, data: Uint8Array) => void;
	};
	loadDynamicLibrary: (path: string, opts?: any) => Promise<any>;
	NgSpiceWasm: new () => {
		loadNetlist: (netlist: string) => void;
		addProbeNode: (node: string, a: number, b: number, c: number) => void;
		run: () => void;
		getResultJson: () => string;
	};
}

enum SpicePullEventType {
	SIMULATE_NETLIST = 'SIMULATE_NETLIST',
	VALIDATE_NETLIST = 'VALIDATE_NETLIST',
}
enum SpicePushEventType {
	SIMULATION_RESULT = 'SIMULATION_RESULT',
	VALIDATION_RESULT = 'VALIDATION_RESULT',
	LOG_RESULT = 'LOG_RESULT',
	ERROR_RESULT = 'ERROR_RESULT',
}
type NgspiceFactory = (opts?: any) => Promise<NgspiceModule>;

function resolveUrl(path: string): string {
	try {
		if (typeof window !== 'undefined' && window.location?.href) {
			return new URL(path, window.location.href).toString();
		}
	}
	catch {}
	return path;
}

function debugLog(message: string, extra?: unknown): void {
	if (!DEBUG) {
		return;
	}
	if (extra !== undefined) {
		console.log(`[ngspice][debug] ${message}`, extra);
	}
	else {
		console.log(`[ngspice][debug] ${message}`);
	}
}

async function getExtensionFile(path: string): Promise<File | undefined> {
	const sysFs = (globalThis as any)?.eda?.sys_FileSystem;
	debugLog('sys_FileSystem available', Boolean(sysFs?.getExtensionFile));
	if (!sysFs?.getExtensionFile) {
		return undefined;
	}
	let file = await sysFs.getExtensionFile(path);
	if (!file && !path.startsWith('/')) {
		file = await sysFs.getExtensionFile(`/${path}`);
	}
	debugLog(`getExtensionFile(${path})`, Boolean(file));
	return file ?? undefined;
}

async function readExtensionText(path: string): Promise<string | undefined> {
	const file = await getExtensionFile(path);
	if (!file) {
		return undefined;
	}
	return await file.text();
}

async function readExtensionBinary(path: string): Promise<Uint8Array | undefined> {
	const file = await getExtensionFile(path);
	if (!file) {
		return undefined;
	}
	const buf = await file.arrayBuffer();
	return new Uint8Array(buf);
}

function base64ToBytes(data: string): Uint8Array {
	if (typeof atob === 'function') {
		const binary = atob(data);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) {
			bytes[i] = binary.charCodeAt(i);
		}
		return bytes;
	}
	if (typeof Buffer !== 'undefined') {
		return new Uint8Array(Buffer.from(data, 'base64'));
	}
	throw new Error('No base64 decoder available');
}

async function loadScript(url: string): Promise<void> {
	debugLog('loadScript url', url);
	debugLog('document available', typeof document !== 'undefined');
	debugLog('fetch available', typeof fetch === 'function');
	if (typeof document !== 'undefined' && document.createElement) {
		await new Promise<void>((resolve, reject) => {
			const script = document.createElement('script');
			script.src = url;
			script.async = true;
			script.onload = () => resolve();
			script.onerror = () => reject(new Error(`Failed to load script: ${url}`));
			document.head.appendChild(script);
		});
		return;
	}
	const extScript = await readExtensionText(NGSPICE_JS);
	if (extScript) {
		debugLog('ngspice.js loaded from extension file');
		const globalEval = globalThis.eval;
		globalEval(extScript);
		return;
	}
	if (ngspiceScriptText) {
		debugLog('ngspice.js loaded from embedded text');
		const globalEval = globalThis.eval;
		globalEval(ngspiceScriptText);
		return;
	}
	if (typeof fetch !== 'function') {
		throw new TypeError('No fetch available to load ngspice.js');
	}
	const resp = await fetch(url);
	if (!resp.ok) {
		throw new Error(`Failed to fetch script: ${url} (HTTP ${resp.status})`);
	}
	const code = await resp.text();
	const globalEval = globalThis.eval;
	globalEval(code);
}

async function ensureNgspiceLoaded(): Promise<void> {
	if (typeof (globalThis as any).Ngspice === 'function') {
		return;
	}
	await loadScript(resolveUrl(NGSPICE_JS));
	if (typeof (globalThis as any).Ngspice !== 'function') {
		throw new TypeError('Ngspice loader not found after script load');
	}
}

async function readNetlist(): Promise<string> {
	const fallback = ['* simple rc', 'V1 in 0 DC 1', 'R1 in out 1k', 'C1 out 0 1u', '.tran 1u 10u', '.end'].join('\n');
	return fallback;
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	console.log('Extension activated with status:', status, 'and arg:', arg);
	switch (status) {
		case 'onStartupFinished':
			eda.sch_Event.addSimulationEnginePullEventListener('sim-engine-monitor', 'all', async (eventType: SpicePullEventType, props: any) => {
				switch (eventType) {
					case SpicePullEventType.SIMULATE_NETLIST:
						runNgspice(props);
						break;
				}
			});
			break;
	}
}

export function about(): void {
	eda.sys_Dialog.showInformationMessage(
		eda.sys_I18n.text('EasyEDA extension SDK v', undefined, undefined, extensionConfig.version),
		eda.sys_I18n.text('About'),
	);
}

export async function runNgspice(props?: any): Promise<void> {
	try {
		debugLog('runNgspice start');
		await ensureNgspiceLoaded();
		const Ngspice = (globalThis as any).Ngspice as NgspiceFactory;
		debugLog('Ngspice loader found', typeof Ngspice === 'function');
		const mainWasm
			= (await readExtensionBinary(NGSPICE_MAIN_WASM)) ?? (embeddedMainWasmBase64 ? base64ToBytes(embeddedMainWasmBase64) : undefined);
		debugLog('main wasm from extension', Boolean(mainWasm));
		const Module = await Ngspice({
			wasmBinary: mainWasm,
			locateFile: (path: string) => resolveUrl(path),
		});
		const sideWasm
			= (await readExtensionBinary(NGSPICE_SIDE_WASM)) ?? (embeddedSideWasmBase64 ? base64ToBytes(embeddedSideWasmBase64) : undefined);
		debugLog('side wasm from extension', Boolean(sideWasm));
		if (sideWasm) {
			if (!Module.FS.analyzePath('/wasm').exists) {
				Module.FS.mkdir('/wasm');
			}
			Module.FS.writeFile(`/${NGSPICE_SIDE_WASM}`, sideWasm);
		}
		await Module.loadDynamicLibrary(`/${NGSPICE_SIDE_WASM}`, {
			global: true,
			nodelete: true,
			loadAsync: true,
		});
		const sim = new Module.NgSpiceWasm();
		const netlist = typeof props?.netlist === 'string' && props.netlist.trim()
			? props.netlist
			: await readNetlist();
		sim.loadNetlist(netlist);
		const probeNodes = Array.isArray(props?.probeNodes) ? props.probeNodes : [];
		for (const node of probeNodes) {
			if (!node || typeof node !== 'object') {
				continue;
			}
			const id = (node as any).ProbeNode;
			if (id === undefined || id === null) {
				continue;
			}
			const probeType = Number((node as any).ProbeType ?? 1);
			const lowLevel = Number((node as any).LowLevel ?? 1);
			const highLevel = Number((node as any).HighLevel ?? 1);
			sim.addProbeNode(String(id), probeType, lowLevel, highLevel);
		}
		sim.run();
		const resultJson = sim.getResultJson();
		eda.sch_SimulationEngine.pushData(SpicePushEventType.SIMULATION_RESULT, resultJson);
	}
	catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[ngspice] run failed:', e);
		eda.sch_SimulationEngine.pushData(SpicePushEventType.ERROR_RESULT, msg);
	}
}
