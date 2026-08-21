import type { SpiceEngine } from "../../core/simulation/spice-engine";
import { trimLogs } from "../../shared/logs";
import type { ProbeTarget } from "../../shared/probe";
import { preferredTraceIdsByDataset } from "../../shared/probe-selection";
import type { SimulationResult } from "../../shared/waveform";

export interface WaveformRunResponse {
	ok: boolean;
	result?: SimulationResult;
	logs: string[];
	error?: string;
}

export async function runWaveformAnalysis(
	engine: SpiceEngine,
	netlist: string,
	probeNodes: ProbeTarget[] = [],
	compatMode?: string,
): Promise<WaveformRunResponse> {
	const logs: string[] = [`Run mode: ${engine.id}`];
	if (!netlist.trim()) return { ok: false, logs, error: "Netlist is empty" };
	let session: Awaited<ReturnType<SpiceEngine["open"]>>["session"] | null = null;
	try {
		const opened = await engine.open(netlist, { probeNodes, compatMode });
		session = opened.session;
		logs.push(...opened.logs);
		const execution = await session.run({ captureWaveforms: true });
		logs.push(...execution.logs);
		if (!execution.ok) return { ok: false, logs: trimLogs(logs), error: execution.error || "SPICE run failed" };
		if (!execution.datasets.length) {
			return {
				ok: false,
				logs: trimLogs([...logs, "SPICE returned no waveform datasets"]),
				error: "No waveform datasets parsed from SPICE result",
			};
		}
		const preferredTraceIds = preferredTraceIdsByDataset(execution.datasets, probeNodes, netlist);
		logs.push(`SPICE parsed datasets: ${execution.datasets.length}, traces: ${execution.datasets.reduce((sum, dataset) => sum + dataset.traces.length, 0)}`);
		return {
			ok: true,
			result: {
				datasets: execution.datasets,
				activeDatasetId: execution.datasets[0]?.id ?? null,
				preferredTraceIdsByDataset: preferredTraceIds,
			},
			logs: trimLogs(logs),
		};
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, logs: trimLogs([...logs, `SPICE failed: ${message}`]), error: message };
	}
	finally {
		session?.dispose();
	}
}
