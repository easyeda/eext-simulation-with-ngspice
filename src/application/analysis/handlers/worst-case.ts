import type { AnalysisHandler } from "../../../core/analysis/contracts";
import type { SpiceEngine } from "../../../core/simulation/spice-engine";
import { runWorstCaseAnalysis } from "../../../features/worst-case/runner";
import type {
	ProductAnalysisArtifact,
	WorstCaseAnalysisRequest,
} from "../contracts";

export function createWorstCaseHandler(
	engine: SpiceEngine,
): AnalysisHandler<WorstCaseAnalysisRequest, ProductAnalysisArtifact> {
	return {
		type: "worst-case",
		execute: async (request) => {
			const response = await runWorstCaseAnalysis(engine, request.netlist, {
				probeNodes: request.options.probeNodes,
				objective: request.options.objective,
				compatMode: request.options.compatMode,
			});
			return {
				ok: response.ok,
				artifacts: response.result
					? [{ kind: "worst-case" as const, payload: response.result }]
					: [],
				logs: response.logs,
				...(response.error ? { error: response.error } : {}),
			};
		},
	};
}
