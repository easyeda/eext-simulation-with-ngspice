import { findAnalysisCommand, normalizeNetlistForNgspice } from "./shared/netlist";
import { normalizeNgspiceMessages } from "./shared/ngspice-normalize";
import type { SimulationResponse, WaveformDataset } from "./shared/types";

type ComplexScalar = number | { real: number; imag: number };

interface RawVariable {
	index: number;
	name: string;
	type: string;
}

interface RawPlot {
	title: string;
	plotName: string;
	flags: string;
	variables: RawVariable[];
	rows: ComplexScalar[][];
}

interface WasmFileSystem {
	writeFile(path: string, data: string | Uint8Array): void;
	readFile(path: string, options?: { encoding?: "utf8" | "binary" }): string | Uint8Array;
	unlink?(path: string): void;
	mkdirTree?(path: string): void;
}

export interface NgspiceWasmModule {
	FS: WasmFileSystem;
	callMain?: (args: string[]) => number | void;
	run?: (args: string[]) => number | void;
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

export function isWasmNgspiceAvailable(): boolean {
	return Boolean(resolveGlobalFactory() || resolveGlobalModule());
}

export async function runNgspiceNetlistWithWasm(
	netlist: string,
	options: WasmNgspiceRunOptions = {},
): Promise<SimulationResponse> {
	const logs: string[] = [];
	if (!netlist.trim()) {
		return { ok: false, logs: ["网表内容为空"], error: "网表内容为空" };
	}

	await ensureWasmNgspiceAvailable(logs, options.wasmBaseUrl);

	const factory = options.factory ?? resolveGlobalFactory();
	const loadedModule = options.module ?? resolveGlobalModule();
	if (!factory && !loadedModule) {
		return {
			ok: false,
			logs: trimLogs([...logs, "未检测到 ngspice WASM loader。插件包应内置 iframe/wasm/ngspice.js，请确认安装的是最新 .eext。"]),
			error: "ngspice WASM loader 未注入",
		};
	}

	logs.push("运行模式: 浏览器内 ngspice WASM");
	const prepared = normalizeNetlistForNgspice(netlist);
	logs.push(...prepared.logs);
	logs.push(`仿真命令: ${findAnalysisCommand(prepared.netlist) || "未识别，交由 ngspice 返回错误"}`);

	try {
		const module = loadedModule ?? await withTimeout(loadModule(factory, options, logs), options.timeoutMs ?? 15_000);
		const response = await runLoadedModule(module, prepared.netlist, logs, options.timeoutMs ?? 60_000);
		return response;
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logs.push(`WASM 运行失败: ${message}`);
		return { ok: false, logs: trimLogs(logs), error: message };
	}
}

export async function ensureWasmNgspiceAvailable(
	logs: string[] = [],
	wasmBaseUrl = DEFAULT_WASM_BASE_URL,
): Promise<boolean> {
	if (isWasmNgspiceAvailable()) return true;
	if (typeof document === "undefined") {
		logs.push("当前环境没有 document，无法动态加载 ngspice WASM loader");
		return false;
	}

	const loaderUrl = resolveAssetUrl(wasmBaseUrl, DEFAULT_WASM_LOADER);
	if (!loaderPromise) {
		logs.push(`尝试加载 ngspice WASM loader: ${loaderUrl}`);
		loaderPromise = loadWasmLoaderScript(loaderUrl, logs);
	}

	const loaded = await loaderPromise;
	if (loaded) logs.push("ngspice WASM loader 已就绪");
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
			if (!available) {
				logs.push("ngspice.js 已加载，但没有暴露 createNgspiceModule / NgspiceModule 接口");
			}
			resolve(available);
		};
		script.onerror = () => {
			logs.push("插件包未包含 iframe/wasm/ngspice.js，WASM 路径暂不可用");
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
	if (!factory) throw new Error("ngspice WASM factory 不存在");
	const wasmBinary = options.wasmBinary ?? resolveEmbeddedWasmBinary(logs);
	if (wasmBinary) logs.push("使用插件内嵌 ngspice.wasm 二进制");
	const module = await factory({
		print: (line) => logs.push(line.slice(0, 900)),
		printErr: (line) => logs.push(line.slice(0, 900)),
		locateFile: (path) => resolveAssetUrl(options.wasmBaseUrl || DEFAULT_WASM_BASE_URL, path),
		...(wasmBinary ? { wasmBinary } : {}),
	});
	if (!module?.FS) throw new Error("ngspice WASM module 缺少 FS 接口");
	installXspiceCodeModels(module, logs);
	logs.push("ngspice WASM module 已加载");
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
		logs.push(`内嵌 ngspice.wasm 解码失败: ${message}`);
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
	if (bufferFactory?.from) {
		return new Uint8Array(bufferFactory.from(base64, "base64"));
	}

	throw new Error("当前环境缺少 atob/Buffer，无法解码内嵌 wasm");
}

async function runLoadedModule(
	module: NgspiceWasmModule,
	netlist: string,
	logs: string[],
	timeoutMs: number,
): Promise<SimulationResponse> {
	const workDir = `/tmp/jlc-ngspice-${Date.now()}-${Math.random().toString(16).slice(2)}`;
	const inputPath = `${workDir}/input.cir`;
	const rawPath = `${workDir}/result.raw`;
	const logPath = `${workDir}/ngspice.log`;

	installXspiceCodeModels(module, logs);
	ensureDir(module, workDir);
	module.FS.writeFile(inputPath, buildBatchNetlist(netlist, rawPath));

	await withTimeout(Promise.resolve().then(() => invokeNgspice(module, inputPath, logPath)), timeoutMs);
	appendVirtualLog(module, logPath, logs);

	const rawText = readVirtualText(module, rawPath);
	if (!rawText.trim()) throw new Error("ngspice WASM 未生成 raw 波形文件");

	const plots = parseAsciiRaw(rawText);
	const datasets = plots.flatMap((plot, index) => plotToDatasets(plot, netlist, index));
	cleanupVirtualFiles(module, [inputPath, rawPath, logPath]);

	if (!datasets.length) {
		return {
			ok: false,
			logs: trimLogs([...logs, "raw 文件已生成，但没有解析到可绘制曲线"]),
			error: "没有解析到波形数据",
		};
	}

	logs.push(`WASM 解析到 ${datasets.length} 组结果，曲线数 ${datasets.reduce((sum, dataset) => sum + dataset.traces.length, 0)}`);
	return {
		ok: true,
		result: {
			datasets,
			activeDatasetId: datasets[0]?.id ?? null,
		},
		logs: trimLogs(logs),
	};
}

function invokeNgspice(module: NgspiceWasmModule, inputPath: string, logPath: string): number | void {
	const args = ["-b", "-o", logPath, inputPath];
	if (module.callMain) return module.callMain(args);
	if (module.run) return module.run(args);
	throw new Error("ngspice WASM module 缺少 callMain/run 入口");
}

function buildBatchNetlist(netlist: string, rawPath: string): string {
	const withoutTrailingEnd = netlist.replace(/^\s*\.end\s*$/im, "").trimEnd();
	return `${withoutTrailingEnd}

.control
set filetype=ascii
set plotwinsize=0
run
write ${rawPath} all
quit
.endc
.end
`;
}

function ensureDir(module: NgspiceWasmModule, path: string) {
	try {
		module.FS.mkdirTree?.(path);
	}
	catch {
		// Existing Emscripten directories can throw on repeated creation.
	}
}

function appendVirtualLog(module: NgspiceWasmModule, logPath: string, logs: string[]) {
	const logText = readVirtualText(module, logPath);
	for (const line of logText.split(/\r?\n/).filter(Boolean).slice(-80)) {
		logs.push(line.slice(0, 900));
	}
}

function readVirtualText(module: NgspiceWasmModule, path: string): string {
	try {
		const value = module.FS.readFile(path, { encoding: "utf8" });
		if (typeof value === "string") return value;
		return new TextDecoder().decode(value);
	}
	catch {
		return "";
	}
}

function cleanupVirtualFiles(module: NgspiceWasmModule, paths: string[]) {
	for (const path of paths) {
		try {
			module.FS.unlink?.(path);
		}
		catch {
			// Best effort cleanup only.
		}
	}
}

function parseAsciiRaw(rawText: string): RawPlot[] {
	const normalized = rawText.replace(/\r\n/g, "\n");
	const chunks = normalized
		.split(/\n(?=Title:\s)/)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
	return chunks.map(parseRawPlot).filter((plot): plot is RawPlot => Boolean(plot));
}

function parseRawPlot(chunk: string): RawPlot | null {
	const lines = chunk.split("\n");
	const variableStart = lines.findIndex((line) => /^Variables:\s*$/i.test(line.trim()));
	const valuesStart = lines.findIndex((line) => /^Values:\s*$/i.test(line.trim()));
	if (variableStart < 0 || valuesStart < 0) return null;

	const variables = parseVariables(lines.slice(variableStart + 1, valuesStart));
	if (variables.length < 2) return null;

	return {
		title: getRawHeader(lines, "Title"),
		plotName: getRawHeader(lines, "Plotname"),
		flags: getRawHeader(lines, "Flags"),
		variables,
		rows: parseRawRows(lines.slice(valuesStart + 1), variables.length),
	};
}

function getRawHeader(lines: string[], name: string): string {
	const line = lines.find((item) => item.toLowerCase().startsWith(`${name.toLowerCase()}:`));
	return line ? line.slice(line.indexOf(":") + 1).trim() : "";
}

function parseVariables(lines: string[]): RawVariable[] {
	const variables: RawVariable[] = [];
	for (const line of lines) {
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 3 && Number.isFinite(Number(parts[0]))) {
			variables.push({ index: Number(parts[0]), name: parts[1], type: parts.slice(2).join(" ") });
		}
	}
	return variables;
}

function parseRawRows(lines: string[], variableCount: number): ComplexScalar[][] {
	const rows: ComplexScalar[][] = [];
	let current: ComplexScalar[] = [];

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;

		const rowMatch = /^(\d+)\s+(.+)$/.exec(line);
		const hasRowIndex = Boolean(rowMatch);
		const valueText = rowMatch ? rowMatch[2] : line;

		if (hasRowIndex && current.length) {
			if (current.length === variableCount) rows.push(current);
			current = [];
		}

		current.push(...parseRawScalars(valueText));
	}

	if (current.length === variableCount) rows.push(current);
	return rows;
}

function parseRawScalars(text: string): ComplexScalar[] {
	const numeric = "[-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?";
	const scalarPattern = new RegExp(`${numeric}(?:\\s*,\\s*${numeric})?`, "g");
	const scalars: ComplexScalar[] = [];
	for (const match of text.replace(/[()]/g, "").matchAll(scalarPattern)) {
		const parsed = parseRawScalar(match[0]);
		if (parsed !== null) scalars.push(parsed);
	}
	return scalars;
}

function parseRawScalar(token: string): ComplexScalar | null {
	const clean = token.trim().replace(/\s*,\s*/g, ",");
	if (!clean) return null;
	if (clean.includes(",")) {
		const [real, imag] = clean.split(",").map(Number);
		return Number.isFinite(real) && Number.isFinite(imag) ? { real, imag } : null;
	}
	const value = Number(clean);
	return Number.isFinite(value) ? value : null;
}

function plotToDatasets(plot: RawPlot, netlist: string, index: number): WaveformDataset[] {
	const vectors: Record<string, ComplexScalar[]> = {};
	for (const variable of plot.variables) {
		vectors[variable.name] = plot.rows.map((row) => row[variable.index]);
	}
	return normalizeNgspiceMessages([{
		plot: plot.plotName || `wasm-plot-${index + 1}`,
		title: plot.title,
		flags: plot.flags,
		vectors,
	}], netlist);
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
			logs.push(`XSPICE code model 预加载失败 ${name}: ${message}`);
		}
	}
	logs.push("XSPICE code models 已加载");
	xspiceInstalledModules.add(module);
}

function resolveEmbeddedXspiceCodeModels(logs: string[]): Record<string, Uint8Array> | undefined {
	const globalLike = globalThis as any;
	const win = globalLike.window as Window | undefined;
	const source = globalLike.__JLC_NGSPICE_XSPICE_CODEMODELS ?? win?.__JLC_NGSPICE_XSPICE_CODEMODELS;
	if (!source) return undefined;

	try {
		const decoded: Record<string, Uint8Array> = {};
		for (const [name, value] of Object.entries(source)) {
			const base64 = Array.isArray(value) ? value.join("") : value;
			decoded[name] = decodeBase64ToUint8Array(base64);
		}
		return decoded;
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logs.push(`XSPICE code models 解码失败: ${message}`);
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
		// Best effort only. The returned factory is enough for this call.
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

function resolveGlobalModule(): NgspiceWasmModule | undefined {
	try {
		const win = globalThis.window;
		const candidates = [win?.NgspiceModule, win?.ngspiceModule, win?.Module];
		return candidates.find((candidate): candidate is NgspiceWasmModule => {
			return Boolean(candidate?.FS && (candidate.callMain || candidate.run));
		});
	}
	catch {
		return undefined;
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = globalThis.setTimeout(() => reject(new Error(`ngspice WASM 超时: ${timeoutMs}ms`)), timeoutMs);
		promise.then((value) => {
			globalThis.clearTimeout(timer);
			resolve(value);
		}).catch((error) => {
			globalThis.clearTimeout(timer);
			reject(error);
		});
	});
}

function trimLogs(logs: string[]): string[] {
	return logs.filter(Boolean).slice(-500);
}
