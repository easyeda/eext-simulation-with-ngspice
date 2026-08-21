import { productAnalysisRegistry } from "./registry";
import type { ProductAnalysisExecution, ProductAnalysisRequest } from "./contracts";
import { productSpiceEngine } from "./engine";

export interface RunnerStatus {
	wasmAvailable: boolean;
	ngspiceAvailable: boolean;
	nativeConnected: false;
	mode: "wasm" | "missing";
}

export async function executeAnalysis(request: ProductAnalysisRequest): Promise<ProductAnalysisExecution> {
	return productAnalysisRegistry.execute(request);
}

export async function getEngineStatus(): Promise<RunnerStatus> {
	const ngspiceAvailable = productSpiceEngine.isAvailable();
	return {
		wasmAvailable: ngspiceAvailable,
		ngspiceAvailable,
		nativeConnected: false,
		mode: ngspiceAvailable ? "wasm" : "missing",
	};
}
