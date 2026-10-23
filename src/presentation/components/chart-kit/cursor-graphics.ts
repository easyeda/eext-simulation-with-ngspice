import type { ECharts } from "echarts";

const CURSOR_LINE_COLOR = "#d32029";

export interface CursorLineGeometry {
	/** 游标竖线的像素 x。 */
	pixel: number;
	top: number;
	bottom: number;
}

/**
 * 固定游标的红色虚线竖线 + 顶部三角拖动手柄(画在 ECharts 图上),波形图与逻辑图共用。
 * 增量更新按 id 匹配,"是否隐藏"必须显式写,否则沿用旧值导致残留。
 */
export class CursorLineGraphics {
	constructor(
		private readonly chart: ECharts,
		private readonly lineId: string,
		private readonly handleId: string,
		private readonly z = 10000,
		private readonly zlevel?: number,
	) {}

	draw(geometry: CursorLineGeometry): void {
		const { pixel, top, bottom } = geometry;
		const layer = this.zlevel === undefined ? {} : { zlevel: this.zlevel };
		this.chart.setOption({
			graphic: [
				{
					id: this.lineId,
					type: "line",
					silent: true,
					z: this.z,
					...layer,
					invisible: false,
					shape: { x1: pixel, y1: top, x2: pixel, y2: bottom },
					style: { stroke: CURSOR_LINE_COLOR, lineWidth: 1.5, lineDash: [5, 4] },
				},
				{
					id: this.handleId,
					type: "polygon",
					silent: true,
					z: this.z + 1,
					...layer,
					invisible: false,
					shape: { points: [[pixel - 7, top - 12], [pixel + 7, top - 12], [pixel, top]] },
					style: { fill: CURSOR_LINE_COLOR, stroke: "#ffffff", lineWidth: 1 },
				},
			],
		}, false);
	}

	hide(): void {
		this.chart.setOption({
			graphic: [
				{ id: this.lineId, type: "line", invisible: true, silent: true, shape: { x1: 0, y1: 0, x2: 0, y2: 0 } },
				{ id: this.handleId, type: "polygon", invisible: true, silent: true, shape: { points: [[0, 0], [0, 0], [0, 0]] } },
			],
		}, false);
	}

	/** 顶部三角手柄命中判定(手柄附近 ±11px 横向、top-16~top+8 纵向)。 */
	isHandleHit(localX: number, localY: number, pixel: number, top: number): boolean {
		return Math.abs(localX - pixel) <= 11 && localY >= top - 16 && localY <= top + 8;
	}
}
