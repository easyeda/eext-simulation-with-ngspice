
/** 由 WaveformChart 每次渲染后回调的绘图区几何（数据范围 + 像素矩形）。 */
export interface McOverlayGeometry {
	left: number;
	right: number;
	top: number;
	bottom: number;
	xMin: number;
	xMax: number;
	xLog: boolean;
	yMin: number;
	yMax: number;
	yLog: boolean;
}

export interface McOverlaySample {
	sampleIndex: number;
	time: Float64Array;
	values: Float32Array;
	color: string;
}

/**
 * MC 叠加层的立即模式画布：
 * -波形数据叠加绘制。
 */
export class McOverlayCanvas {
	private canvas: HTMLCanvasElement | null = null;
	private ctx: CanvasRenderingContext2D | null = null;
	private container: HTMLElement | null = null;
	private geometry: McOverlayGeometry | null = null;
	private series: McOverlaySample[] = [];
	private highlightedSampleIndex: number | null = null;
	private displayMode: "line" | "points" | "both" = "line";

	attach(container: HTMLElement): void {
		this.detach();
		this.container = container;
		const canvas = document.createElement("canvas");
		canvas.className = "mc-overlay-canvas";
		Object.assign(canvas.style, {
			position: "absolute",
			inset: "0",
			pointerEvents: "none",
			zIndex: "6",
		} as CSSStyleDeclaration);
		container.appendChild(canvas);
		this.canvas = canvas;
	}

	detach(): void {
		this.canvas?.remove();
		this.canvas = null;
		this.ctx = null;
		this.container = null;
		this.series = [];
		this.geometry = null;
	}

	/** ECharts 渲染后回调的几何（数据范围 + 像素矩形）；变更即整体重绘。 */
	setGeometry(geometry: McOverlayGeometry | null): void {
		const changed = JSON.stringify(geometry) !== JSON.stringify(this.geometry);
		this.geometry = geometry;
		if (!geometry) {
			this.clearBitmap();
			return;
		}
		this.resizeBitmap();
		if (changed || this.ctx === null) this.redraw();
	}

	/** 立即模式核心：只画这一条新样本，不影响已绘制的任何内容。 */
	addSample(sample: McOverlaySample): void {
		this.series.push(sample);
		this.drawSample(sample);
	}

	/** 同步显示模式（线/点/线+点），变更即重绘。 */
	setDisplayMode(mode: "line" | "points" | "both"): void {
		if (this.displayMode === mode) return;
		this.displayMode = mode;
		this.redraw();
	}

	setHighlightedSample(sampleIndex: number | null): void {
		if (this.highlightedSampleIndex === sampleIndex) return;
		this.highlightedSampleIndex = sampleIndex;
		this.redraw();
	}

	getSampleCount(): number {
		return this.series.length;
	}

	clear(): void {
		this.series = [];
		this.highlightedSampleIndex = null;
		this.redraw();
	}

	redraw(): void {
		this.clearBitmap();
		if (!this.ctx || !this.geometry) return;
		this.resizeBitmap();
		const { ctx } = this;
		const { left, top, width, height } = this.plotRect();
		ctx.save();
		ctx.beginPath();
		ctx.rect(left, top, width, height);
		ctx.clip();
		// 有高亮样本时：其余全部置灰，最后单独绘制高亮样本（保证在最上层）。
		const highlighted = this.highlightedSampleIndex === null
			? null
			: this.series.find((sample) => sample.sampleIndex === this.highlightedSampleIndex) ?? null;
		for (const sample of this.series) {
			if (sample === highlighted) continue;
			this.drawSamplePath(sample, this.highlightedSampleIndex !== null);
		}
		if (highlighted) this.drawSamplePath(highlighted, false);
		ctx.restore();
	}

	private drawSample(sample: McOverlaySample): void {
		if (!this.ctx || !this.geometry) return;
		const { left, top, width, height } = this.plotRect();
		const ctx = this.ctx;
		ctx.save();
		ctx.beginPath();
		ctx.rect(left, top, width, height);
		ctx.clip();
		this.drawSamplePath(sample, this.isDimmed(sample));
		ctx.restore();
	}

	private isDimmed(sample: McOverlaySample): boolean {
		return this.highlightedSampleIndex !== null && sample.sampleIndex !== this.highlightedSampleIndex;
	}

	/** 视口裁剪 + 逐像素列 min/max 画线：窗口内点少画精确折线（圆点必在线上），太密才列聚合。 */
	private drawSamplePath(sample: McOverlaySample, dimmed: boolean): void {
		const ctx = this.ctx;
		if (!ctx || !this.geometry) return;
		const highlighted = !dimmed && this.highlightedSampleIndex === sample.sampleIndex;
		// 置灰态：统一浅灰、不透明度降低；正常态：原始鲜艳色。
		ctx.strokeStyle = dimmed ? "#c9cdd4" : sample.color;
		ctx.globalAlpha = dimmed ? 0.55 : 1;
		const count = Math.min(sample.time.length, sample.values.length);
		if (!count) return;
		const maxColumns = Math.max(64, Math.floor(this.plotRect().width));
		// 可见窗口索引（二分；前后各多取一点，保证视口边缘的线条连续）。
		let i0 = mcLowerBound(sample.time, this.geometry.xMin);
		let i1 = mcLowerBound(sample.time, this.geometry.xMax) + 1;
		i0 = Math.max(0, i0 - 1);
		i1 = Math.min(count, i1 + 1);
		const visibleCount = i1 - i0;
		if (visibleCount <= 2) return;
		// 点模式：只画视口内的采样圆点（每条 ≤400 个，等距）。
		if (this.displayMode === "points") {
			const dotStride = Math.max(1, Math.ceil(visibleCount / 400));
			ctx.fillStyle = dimmed ? "#c9cdd4" : sample.color;
			ctx.beginPath();
			for (let index = i0; index < i1; index += dotStride) {
				const px = this.xToPixel(sample.time[index]);
				const py = this.yToPixel(sample.values[index]);
				ctx.moveTo(px + 2, py);
				ctx.arc(px, py, 2, 0, Math.PI * 2);
			}
			ctx.fill();
			return;
		}
		ctx.lineWidth = highlighted ? 2 : 1;
		ctx.beginPath();
		if (visibleCount <= maxColumns * 2) {
			// 窗口内点数不多：画精确折线——插值圆点必然落在线上。
			for (let index = i0; index < i1; index += 1) {
				const px = this.xToPixel(sample.time[index]);
				const py = this.yToPixel(sample.values[index]);
				if (index === i0) ctx.moveTo(px, py);
				else ctx.lineTo(px, py);
			}
		}
		else {
			// 窗口内仍过密：每列聚合 min/max（连续折线、保极值、不混叠）。
			const step = visibleCount / maxColumns;
			for (let column = 0; column < maxColumns; column += 1) {
				const start = i0 + Math.floor(column * step);
				const end = Math.min(i1, i0 + Math.floor((column + 1) * step) + 1);
				if (end <= start) continue;
				let min = sample.values[start];
				let max = min;
				for (let index = start; index < end; index += 1) {
					const value = sample.values[index];
					if (value < min) min = value;
					if (value > max) max = value;
				}
				const pxFirst = this.xToPixel(sample.time[start]);
				const pxLast = this.xToPixel(sample.time[end - 1]);
				const pyMin = this.yToPixel(min);
				const pyMax = this.yToPixel(max);
				if (column === 0) ctx.moveTo(pxFirst, pyMin);
				else ctx.lineTo(pxFirst, pyMin);
				ctx.lineTo(pxLast, pyMax);
			}
		}
		ctx.stroke();
		// 线+点模式：折线上叠加视口内采样圆点（≤400 个/条）。
		if (this.displayMode === "both") {
			const dotStride = Math.max(1, Math.ceil(visibleCount / 400));
			ctx.fillStyle = dimmed ? "#c9cdd4" : sample.color;
			ctx.beginPath();
			for (let index = i0; index < i1; index += dotStride) {
				const px = this.xToPixel(sample.time[index]);
				const py = this.yToPixel(sample.values[index]);
				ctx.moveTo(px + 2, py);
				ctx.arc(px, py, 2, 0, Math.PI * 2);
			}
			ctx.fill();
		}
		ctx.globalAlpha = 1;
	}


	private xToPixel(x: number): number {
		const { left, right, xMin, xMax, xLog } = this.geometry!;
		const fraction = xLog
			? Math.log(x / xMin) / Math.log(xMax / xMin)
			: (x - xMin) / (xMax - xMin);
		return left + fraction * (right - left);
	}

	private yToPixel(y: number): number {
		const { top, bottom, yMin, yMax, yLog } = this.geometry!;
		const fraction = yLog
			? Math.log(y / yMin) / Math.log(yMax / yMin)
			: (y - yMin) / (yMax - yMin);
		return bottom - fraction * (bottom - top);
	}

	private plotRect() {
		const g = this.geometry!;
		return {
			left: g.left,
			top: g.top,
			width: Math.max(1, g.right - g.left),
			height: Math.max(1, g.bottom - g.top),
			right: g.right,
			bottom: g.bottom,
		};
	}

	private resizeBitmap(): void {
		const canvas = this.canvas;
		const container = this.container;
		if (!canvas || !container) return;
		const width = container.clientWidth;
		const height = container.clientHeight;
		const dpr = window.devicePixelRatio || 1;
		const targetW = Math.max(1, Math.floor(width * dpr));
		const targetH = Math.max(1, Math.floor(height * dpr));
		if (canvas.width !== targetW || canvas.height !== targetH) {
			canvas.width = targetW;
			canvas.height = targetH;
		}
		const ctx = canvas.getContext("2d");
		if (!ctx) return;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		this.ctx = ctx;
	}

	private clearBitmap(): void {
		if (!this.ctx || !this.canvas) return;
		this.ctx.save();
		this.ctx.setTransform(1, 0, 0, 1, 0, 0);
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.restore();
	}
}

/** 二分下界：第一个 time[index] >= x 的下标（time 非递减）。 */
function mcLowerBound(time: Float64Array, x: number): number {
	let lo = 0;
	let hi = time.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (time[mid] < x) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}
