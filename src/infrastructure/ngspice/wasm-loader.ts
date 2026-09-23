import type { ProbeTarget } from "../../shared/probe";

interface WasmFileSystem {
	writeFile(path: string, data: string | Uint8Array): void;
	readFile(path: string, options?: { encoding?: "utf8" | "binary" }): string | Uint8Array;
	unlink?(path: string): void;
	mkdirTree?(path: string): void;
}

export interface NgspiceWasmModule {
	FS: WasmFileSystem;
	NgSpiceWasm?: unknown;
	loadDynamicLibrary?: (path: string, flags?: { global?: boolean; nodelete?: boolean; allowUndefined?: boolean }) => unknown;
	print?: (text: string) => void;
	printErr?: (text: string) => void;
}

type WasmBinary = ArrayBuffer | Uint8Array;

export type NgspiceWasmFactory = (options?: {
	print?: (text: string) => void;
	printErr?: (text: string) => void;
	locateFile?: (path: string) => string;
	wasmBinary?: WasmBinary;
}) => NgspiceWasmModule | Promise<NgspiceWasmModule>;

export interface WasmNgspiceRunOptions {
	factory?: NgspiceWasmFactory;
	module?: NgspiceWasmModule;
	wasmBinary?: WasmBinary;
	wasmBaseUrl?: string;
	timeoutMs?: number;
	probeNodes?: ProbeTarget[];
	installXspiceCodeModels?: boolean;
}

declare global {
	interface Window {
		createNgspiceModule?: NgspiceWasmFactory;
		NgspiceModuleFactory?: NgspiceWasmFactory;
		ngspiceModuleFactory?: NgspiceWasmFactory;
		NgspiceModule?: NgspiceWasmModule;
		ngspiceModule?: NgspiceWasmModule;
		Module?: NgspiceWasmModule;
		__JLC_NGSPICE_WASM_BASE64?: string | string[];
		__JLC_NGSPICE_WASM_BINARY?: Uint8Array;
		__JLC_NGSPICE_XSPICE_CODEMODELS?: Record<string, string | string[]>;
	}
}

const DEFAULT_WASM_BASE_URL = "/iframe/wasm";
const DEFAULT_WASM_LOADER = "ngspice.js";
const XSPICE_CODE_MODEL_DIR = "/usr/lib/ngspice";
const XSPICE_CODE_MODEL_NAMES = ["spice2poly.cm", "analog.cm", "digital.cm", "xtradev.cm", "xtraevt.cm", "table.cm", "tlines.cm"];
let loaderPromise: Promise<boolean> | null = null;
const xspiceInstalledModules = new WeakSet<NgspiceWasmModule>();
// 每次分析都会重建 WASM 模块，环境信息类日志只记录一次，避免每次运行重复打印。
const infoLogsEmitted = new Set<string>();

function pushInfoOnce(logs: string[], message: string): void {
	if (infoLogsEmitted.has(message)) return;
	infoLogsEmitted.add(message);
	logs.push(message);
}

export function isWasmNgspiceAvailable(): boolean {
	return Boolean(resolveGlobalFactory() || resolveGlobalNgspiceModule());
}

export async function loadNgspiceWasmModule(
	options: WasmNgspiceRunOptions = {},
	logs: string[] = [],
): Promise<NgspiceWasmModule> {
	if (options.module) {
		if (options.installXspiceCodeModels !== false) installXspiceCodeModels(options.module, logs);
		return options.module;
	}

	await ensureWasmNgspiceAvailable(logs, options.wasmBaseUrl);

	const loadedModule = resolveGlobalNgspiceModule();
	if (loadedModule) {
		if (options.installXspiceCodeModels !== false) installXspiceCodeModels(loadedModule, logs);
		return loadedModule;
	}

	const factory = options.factory ?? resolveGlobalFactory();
	if (!factory) throw new Error("ngspice WASM loader is not available");
	return withTimeout(loadModule(factory, options, logs), options.timeoutMs ?? 15_000);
}

export async function ensureWasmNgspiceAvailable(
	logs: string[] = [],
	wasmBaseUrl = DEFAULT_WASM_BASE_URL,
): Promise<boolean> {
	if (isWasmNgspiceAvailable()) return true;
	if (typeof document === "undefined") {
		logs.push("No document object is available, so ngspice WASM loader cannot be injected");
		return false;
	}

	const loaderUrl = resolveAssetUrl(wasmBaseUrl, DEFAULT_WASM_LOADER);
	if (!loaderPromise) {
		logs.push(`Loading ngspice WASM loader: ${loaderUrl}`);
		loaderPromise = loadWasmLoaderScript(loaderUrl, logs);
	}

	const loaded = await loaderPromise;
	if (loaded) logs.push("ngspice WASM loader is ready");
	return loaded;
}

function loadWasmLoaderScript(loaderUrl: string, logs: string[]): Promise<boolean> {
	return new Promise((resolve) => {
		const existing = document.querySelector<HTMLScriptElement>(`script[data-jlc-ngspice-wasm-loader="${loaderUrl}"]`);
		if (existing) {
			existing.addEventListener("load", () => resolve(isWasmNgspiceAvailable()), { once: true });
			existing.addEventListener("error", () => resolve(false), { once: true });
			return;
		}

		const script = document.createElement("script");
		script.src = loaderUrl;
		script.async = true;
		script.dataset.jlcNgspiceWasmLoader = loaderUrl;
		script.onload = () => {
			const available = isWasmNgspiceAvailable();
			if (!available) logs.push("ngspice.js loaded, but createNgspiceModule / NgSpiceWasm is not exposed");
			resolve(available);
		};
		script.onerror = () => {
			logs.push("The plugin package does not include iframe/wasm/ngspice.js, so the WASM path is unavailable");
			resolve(false);
		};
		document.head.appendChild(script);
	});
}

async function loadModule(
	factory: NgspiceWasmFactory | undefined,
	options: WasmNgspiceRunOptions,
	logs: string[],
): Promise<NgspiceWasmModule> {
	if (!factory) throw new Error("ngspice WASM factory is not available");
	const wasmBinary = options.wasmBinary ?? resolveEmbeddedWasmBinary(logs);
	if (wasmBinary) pushInfoOnce(logs, "Using embedded ngspice.wasm binary");
	const module = await factory({
		print: (line) => logs.push(line.slice(0, 900)),
		printErr: (line) => logs.push(line.slice(0, 900)),
		locateFile: (path) => resolveAssetUrl(options.wasmBaseUrl || DEFAULT_WASM_BASE_URL, path),
		...(wasmBinary ? { wasmBinary } : {}),
	});
	if (!module?.FS) throw new Error("ngspice WASM module is missing FS");
	if (!module.NgSpiceWasm) throw new Error("ngspice WASM module is missing NgSpiceWasm");
	if (options.installXspiceCodeModels !== false) installXspiceCodeModels(module, logs);
	pushInfoOnce(logs, "ngspice WASM module loaded");
	return module;
}

function resolveEmbeddedWasmBinary(logs: string[]): Uint8Array | undefined {
	const globalLike = globalThis as any;
	const win = globalLike.window as Window | undefined;
	const cached = toUint8Array(globalLike.__JLC_NGSPICE_WASM_BINARY) ?? toUint8Array(win?.__JLC_NGSPICE_WASM_BINARY);
	if (cached) return cached;

	const base64Value = globalLike.__JLC_NGSPICE_WASM_BASE64 ?? win?.__JLC_NGSPICE_WASM_BASE64;
	if (!base64Value) return undefined;

	try {
		const base64 = Array.isArray(base64Value) ? base64Value.join("") : base64Value;
		const decoded = decodeBase64ToUint8Array(base64);
		globalLike.__JLC_NGSPICE_WASM_BINARY = decoded;
		if (win) win.__JLC_NGSPICE_WASM_BINARY = decoded;
		return decoded;
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logs.push(`Embedded ngspice.wasm decode failed: ${message}`);
		return undefined;
	}
}

function toUint8Array(value: unknown): Uint8Array | undefined {
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return undefined;
}

function decodeBase64ToUint8Array(base64: string): Uint8Array {
	if (typeof atob === "function") {
		const binary = atob(base64);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	}

	const bufferFactory = (globalThis as any).Buffer;
	if (bufferFactory?.from) return new Uint8Array(bufferFactory.from(base64, "base64"));

	throw new Error("No atob/Buffer implementation is available for embedded wasm decoding");
}

function installXspiceCodeModels(module: NgspiceWasmModule, logs: string[]) {
	if (xspiceInstalledModules.has(module)) return;
	const codeModels = resolveEmbeddedXspiceCodeModels(logs);
	if (!codeModels) return;

	ensureDir(module, XSPICE_CODE_MODEL_DIR);
	ensureDir(module, "/usr/share/ngspice/scripts");

	for (const name of XSPICE_CODE_MODEL_NAMES) {
		const bytes = codeModels[name];
		if (bytes) module.FS.writeFile(`${XSPICE_CODE_MODEL_DIR}/${name}`, bytes);
	}

	module.FS.writeFile("/usr/share/ngspice/scripts/spinit", [
		"set xspice_enabled",
		...XSPICE_CODE_MODEL_NAMES.map((name) => `codemodel ${XSPICE_CODE_MODEL_DIR}/${name}`),
		"",
	].join("\n"));

	if (!module.loadDynamicLibrary) return;

	for (const name of XSPICE_CODE_MODEL_NAMES) {
		try {
			module.loadDynamicLibrary(`${XSPICE_CODE_MODEL_DIR}/${name}`, {
				global: true,
				nodelete: true,
				allowUndefined: true,
			});
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logs.push(`XSPICE code model preload failed for ${name}: ${message}`);
		}
	}
	pushInfoOnce(logs, "XSPICE code models loaded");
	xspiceInstalledModules.add(module);
}

function ensureDir(module: NgspiceWasmModule, path: string) {
	try {
		module.FS.mkdirTree?.(path);
	}
	catch {
		// 重复创建已有的 Emscripten 目录时可能抛出异常。
	}
}

function resolveEmbeddedXspiceCodeModels(logs: string[]): Record<string, Uint8Array> | undefined {
	const globalLike = globalThis as any;
	const win = globalLike.window as Window | undefined;
	const source = globalLike.__JLC_NGSPICE_XSPICE_CODEMODELS ?? win?.__JLC_NGSPICE_XSPICE_CODEMODELS;
	if (!source) return undefined;

	try {
		const decoded: Record<string, Uint8Array> = {};
		for (const [name, value] of Object.entries(source)) {
			const base64 = Array.isArray(value) ? value.join("") : typeof value === "string" ? value : "";
			if (!base64) continue;
			decoded[name] = decodeBase64ToUint8Array(base64);
		}
		return decoded;
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logs.push(`XSPICE code models decode failed: ${message}`);
		return undefined;
	}
}

function resolveGlobalFactory(): NgspiceWasmFactory | undefined {
	try {
		const globalFactory = factoryFromCommonJsGlobal();
		const win = globalThis.window;
		const candidates = [
			win?.createNgspiceModule,
			(globalThis as any).createNgspiceModule,
			win?.NgspiceModuleFactory,
			win?.ngspiceModuleFactory,
			globalFactory,
		];
		const factory = candidates.find((candidate): candidate is NgspiceWasmFactory => typeof candidate === "function");
		if (factory) exposeFactory(factory);
		return factory;
	}
	catch {
		return undefined;
	}
}

function factoryFromCommonJsGlobal(): NgspiceWasmFactory | undefined {
	const globalLike = globalThis as any;
	const candidates = [
		moduleExportFactory(globalLike.module),
		moduleExportFactory(globalLike.module?.exports),
		moduleExportFactory(globalLike.exports),
		moduleExportFactory(globalThis.window && (globalThis.window as any).module),
		moduleExportFactory(globalThis.window && (globalThis.window as any).exports),
	];
	return candidates.find((candidate): candidate is NgspiceWasmFactory => typeof candidate === "function");
}

function moduleExportFactory(value: any): NgspiceWasmFactory | undefined {
	if (!value) return undefined;
	if (typeof value === "function") return value;
	const exported = value.exports ?? value;
	if (typeof exported === "function") return exported;
	if (typeof exported?.default === "function") return exported.default;
	if (typeof exported?.createNgspiceModule === "function") return exported.createNgspiceModule;
	return undefined;
}

function exposeFactory(factory: NgspiceWasmFactory) {
	try {
		(globalThis as any).createNgspiceModule = factory;
		if (globalThis.window) globalThis.window.createNgspiceModule = factory;
	}
	catch {
		// 尽力暴露 Factory；当前调用只需要返回的 Factory 即可继续。
	}
}

function resolveAssetUrl(baseUrl: string, fileName: string): string {
	const normalizedBase = baseUrl.replace(/\/$/, "");
	const relativePath = `${normalizedBase}/${fileName}`;
	try {
		return new URL(relativePath, document.baseURI).href;
	}
	catch {
		return relativePath;
	}
}

function resolveGlobalNgspiceModule(): NgspiceWasmModule | undefined {
	try {
		const win = globalThis.window;
		const candidates = [win?.NgspiceModule, win?.ngspiceModule, win?.Module];
		return candidates.find((candidate): candidate is NgspiceWasmModule => Boolean(candidate?.FS && candidate.NgSpiceWasm));
	}
	catch {
		return undefined;
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(`ngspice WASM timeout: ${timeoutMs}ms`)), timeoutMs);
		promise.then((value) => {
			globalThis.clearTimeout(timer);
			resolve(value);
		}).catch((error) => {
			globalThis.clearTimeout(timer);
			reject(error);
		});
	});
}
