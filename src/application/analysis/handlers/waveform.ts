import type { AnalysisHandler } from "../../../core/analysis/contracts";
import type { SpiceEngine } from "../../../core/simulation/spice-engine";
import { runWaveformAnalysis } from "../../../features/waveform/runner";
import { SPICE_COMMAND_TYPES } from "../../../shared/analysis-types";
import type {
	ProductAnalysisArtifact,
	StandardAnalysisRequest,
} from "../contracts";
import { validateNativeAnalysisCommand } from "../validation";

export function createWaveformHandlers(
	engine: SpiceEngine,
): Array<AnalysisHandler<StandardAnalysisRequest, ProductAnalysisArtifact>> {
	return SPICE_COMMAND_TYPES.map((type) => ({
		type,
		execute: (request) => executeWaveform(engine, request),
	}));
}

async function executeWaveform(engine: SpiceEngine, request: StandardAnalysisRequest) {
	const validation = validateNativeAnalysisCommand(request.netlist, request.analysisType);
	if (!validation.ok) return { ok: false, artifacts: [], logs: [], error: validation.error };
	const response = await runWaveformAnalysis(
		engine,
		request.netlist,
		request.options.probeNodes,
		request.options.compatMode,
	);
	return {
		ok: response.ok,
		artifacts: response.result
			? [{ kind: "waveform" as const, payload: response.result }]
			: [],
		logs: response.logs,
		...(response.error ? { error: response.error } : {}),
	};
}
