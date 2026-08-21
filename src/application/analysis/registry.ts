import { AnalysisRegistry } from "../../core/analysis/registry";
import type { SpiceEngine } from "../../core/simulation/spice-engine";
import type {
	ProductAnalysisArtifact,
	ProductAnalysisRequest,
} from "./contracts";
import { productSpiceEngine } from "./engine";
import { createMonteCarloHandler } from "./handlers/monte-carlo";
import { createWaveformHandlers } from "./handlers/waveform";
import { createWorstCaseHandler } from "./handlers/worst-case";

export const productAnalysisRegistry = createProductAnalysisRegistry(productSpiceEngine);

export function createProductAnalysisRegistry(
	engine: SpiceEngine,
): AnalysisRegistry<ProductAnalysisRequest, ProductAnalysisArtifact> {
	const registry = new AnalysisRegistry<ProductAnalysisRequest, ProductAnalysisArtifact>({
		name: engine.id,
		resultProtocolVersion: engine.resultProtocolVersion,
	});
	for (const handler of createWaveformHandlers(engine)) registry.register(handler);
	registry.register(createMonteCarloHandler(engine));
	registry.register(createWorstCaseHandler(engine));
	return registry;
}
