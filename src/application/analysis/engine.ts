import type { SpiceEngine } from "../../core/simulation/spice-engine";
import { WasmSpiceEngine } from "../../infrastructure/ngspice/engine";

const WASM_BASE_URL = "/iframe/wasm";
const MODULE_LOAD_TIMEOUT_MS = 60_000;

/** 当前批处理分析使用的 SPICE 后端，由应用组合层统一装配。 */
export const productSpiceEngine: SpiceEngine = new WasmSpiceEngine({
	wasmBaseUrl: WASM_BASE_URL,
	timeoutMs: MODULE_LOAD_TIMEOUT_MS,
});
