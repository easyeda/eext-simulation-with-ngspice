import type { WaveformDataset, WaveformTrace } from "./waveform";

/**
 * 相位解卷绕（phase unwrapping）
 */

/** 解卷绕一条等间隔采样的相位值序列；非有限值保持原样并重置基准。 */
export function unwrapPhaseSeries(values: ArrayLike<number>): Float32Array {
	const out = new Float32Array(values.length);
	let prevRaw = Number.NaN;
	let prevUnwrapped = Number.NaN;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!Number.isFinite(value)) {
			out[index] = value;
			prevRaw = Number.NaN;
			prevUnwrapped = Number.NaN;
			continue;
		}
		if (Number.isFinite(prevRaw)) {
			let delta = value - prevRaw;
			while (delta > 180) delta -= 360;
			while (delta < -180) delta += 360;
			prevUnwrapped += delta;
		}
		else {
			prevUnwrapped = value;
		}
		prevRaw = value;
		out[index] = prevUnwrapped;
	}
	return out;
}

export function unwrapTracePoints(points: Array<[number, number]>): Array<[number, number]> {
	const values = points.map((point) => point[1]);
	const unwrapped = unwrapPhaseSeries(values);
	return points.map((point, index) => [point[0], unwrapped[index]]);
}

/** 相位曲线（axisId === "phase"）才解卷绕，其余曲线原样返回同一引用。 */
export function unwrapPhaseTrace(trace: WaveformTrace): WaveformTrace {
	if (trace.axisId !== "phase" || !trace.points.length) return trace;
	return { ...trace, points: unwrapTracePoints(trace.points) };
}

/** 开关开启时相位曲线解卷绕 */
export function unwrapDatasetForDisplay(dataset: WaveformDataset, enabled: boolean): WaveformDataset {
	if (!enabled || !datasetHasPhaseTraces(dataset)) return dataset;
	return {
		...dataset,
		traces: dataset.traces.map((trace) => unwrapPhaseTrace(trace)),
	};
}

export function datasetHasPhaseTraces(dataset: WaveformDataset | null | undefined): boolean {
	return Boolean(dataset?.traces.some((trace) => trace.axisId === "phase" && trace.points.length));
}
