import type { AnalysisHandler } from "../../../core/analysis/contracts";
import type { SpiceEngine } from "../../../core/simulation/spice-engine";
import { runMonteCarloAnalysis } from "../../../features/monte-carlo/runner";
import type {
	MonteCarloAnalysisRequest,
	ProductAnalysisArtifact,
} from "../contracts";
import { validateNativeAnalysisCommand } from "../validation";

export function createMonteCarloHandler(
	engine: SpiceEngine,
): AnalysisHandler<MonteCarloAnalysisRequest, ProductAnalysisArtifact> {
	return {
		type: "monte-carlo",
		execute: async (request) => {
			const validation = validateNativeAnalysisCommand(request.netlist);
			if (!validation.ok) {
				return { ok: false, artifacts: [], logs: [], error: validation.error };
			}
			const response = await runMonteCarloAnalysis(engine, request.netlist, {
				probeNodes: request.options.probeNodes,
				sampleCount: request.options.sampleCount,
				seed: request.options.seed,
				compatMode: request.options.compatMode,
			});
			return {
				ok: response.ok,
				artifacts: response.result
					? [{ kind: "monte-carlo" as const, payload: response.result }]
					: [],
				logs: response.logs,
				...(response.error ? { error: response.error } : {}),
			};
		},
	};
}
