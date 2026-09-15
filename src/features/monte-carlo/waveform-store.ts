import type { WaveformDataset } from "../../shared/waveform";

export interface McStoredSample {
	sampleIndex: number;
	/** timePool 中该样本时间向量的下标（相同时间向量共享同一份）。 */
	timeRef: number;
	names: string[];
	values: Float32Array[];
	/** 该样本相对原始分辨率的抽稀因子（与全体当前分辨率一致）。 */
	stride: number;
}

export interface McTimeSeries {
	sampleIndex: number;
	time: Float64Array;
	values: Float32Array;
}

/** 内存预算默认 768MB（超出后全体同步隔点抽稀，直到回到预算内）。 */
const DEFAULT_MAX_BYTES = 768 * 1048576;

/**
 * MC 波形累积存储：全量保留每个样本的波形，供叠加渲染与包络计算使用。
 * - 时间向量按内容去重共享（同电路固定步长 .tran 的样本时间一致），
 *   自适应步长场景自动回退为每样本独立时间。
 * - 值统一存 Float32 压缩内存。
 * - 内存预算：总字节超过 maxBytes 时全体样本与时间向量同步隔点抽稀
 *   （stride 翻倍、时间与值保持对齐），预算内“全分辨率保留”，绝不无界增长。
 */
export class McWaveformStore {
	private timePool: Float64Array[] = [];
	private stored: McStoredSample[] = [];
	private template: WaveformDataset | null = null;
	private bytes = 0;
	private trims = 0;

	constructor(private readonly maxBytes: number = DEFAULT_MAX_BYTES) {}

	addSample(sampleIndex: number, dataset: WaveformDataset, traceFilter: ReadonlySet<string> | null): void {
		if (!this.template) this.template = dataset;
		const rawTime = datasetTimeVector(dataset);
		if (!rawTime) return;
		// 新样本到达时是全分辨率；先对齐到全体当前抽稀因子，再与时间池比对/入库。
		const stride = this.getStride();
		const time = stride > 1 ? decimateTime(rawTime, stride) : rawTime;
		let timeRef = this.timePool.findIndex((item) => sameTimeVector(item, time));
		if (timeRef < 0) {
			this.timePool.push(time);
			timeRef = this.timePool.length - 1;
			this.bytes += time.byteLength;
		}
		const names: string[] = [];
		const values: Float32Array[] = [];
		for (const trace of dataset.traces) {
			// traceFilter 为精确的 trace 名/id 白名单（由首样本模板 + EDA 探针计算，
			// 匹配规则与 overlay 一致，含 AC gain/phase 后缀）。
			if (traceFilter && !traceFilter.has(trace.name) && !traceFilter.has(trace.id)) continue;
			names.push(trace.name);
			const valueArray = Float32Array.from(trace.points, (point) => point[1]);
			values.push(stride > 1 ? decimate(valueArray, stride) : valueArray);
			this.bytes += values[values.length - 1].byteLength;
		}
		if (!names.length) return;
		this.stored.push({ sampleIndex, timeRef, names, values, stride });
		this.enforceBudget();
	}

	getTemplate(): WaveformDataset | null {
		return this.template;
	}

	getSampleCount(): number {
		return this.stored.length;
	}

	/** 当前全体样本的抽稀因子（1 = 全分辨率）。 */
	getStride(): number {
		return this.stored.length ? this.stored[this.stored.length - 1].stride : 1;
	}

	/** 内存预算触发的抽稀次数。 */
	getTrimCount(): number {
		return this.trims;
	}

	approxBytes(): number {
		return this.bytes;
	}

	/** 取某个 trace 名的全部样本序列（按采集顺序）。 */
	getSeries(traceName: string): McTimeSeries[] {
		const result: McTimeSeries[] = [];
		for (const sample of this.stored) {
			const index = sample.names.indexOf(traceName);
			if (index < 0) continue;
			result.push({
				sampleIndex: sample.sampleIndex,
				time: this.timePool[sample.timeRef],
				values: sample.values[index],
			});
		}
		return result;
	}

	/** 预算超限时全体同步隔点抽稀（时间与值保持对齐），直到回到预算内。 */
	private enforceBudget(): void {
		while (this.bytes > this.maxBytes && this.stored.length > 0 && this.getStride() < 4096) {
			this.bytes = 0;
			for (let index = 0; index < this.timePool.length; index += 1) {
				this.timePool[index] = decimateTime(this.timePool[index], 2);
				this.bytes += this.timePool[index].byteLength;
			}
			for (const sample of this.stored) {
				sample.values = sample.values.map((value) => decimate(value, 2));
				sample.stride *= 2;
				this.bytes += sample.values.reduce((sum, value) => sum + value.byteLength, 0);
			}
			this.trims += 1;
		}
	}
}

/** 按 stride 抽稀值数组（隔点取样，保留首点）。 */
function decimate(values: Float32Array, stride: number): Float32Array {
	if (stride <= 1) return values;
	const out = new Float32Array(Math.ceil(values.length / stride));
	for (let index = 0; index < out.length; index += 1) {
		out[index] = values[index * stride];
	}
	return out;
}

function decimateTime(time: Float64Array, stride: number): Float64Array {
	if (stride <= 1) return time;
	const out = new Float64Array(Math.ceil(time.length / stride));
	for (let index = 0; index < out.length; index += 1) {
		out[index] = time[index * stride];
	}
	return out;
}

/** 提取 dataset 的横轴向量（各 trace 共享同一横轴，取第一条）。 */
function datasetTimeVector(dataset: WaveformDataset): Float64Array | null {
	const trace = dataset.traces[0];
	if (!trace?.points.length) return null;
	const time = new Float64Array(trace.points.length);
	for (let index = 0; index < trace.points.length; index += 1) {
		time[index] = trace.points[index][0];
	}
	return time;
}

function sameTimeVector(a: Float64Array, b: Float64Array): boolean {
	if (a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}
