/**
 * 画布共享调色板与图例图标。
 */
export const CHART_PALETTE = ["#1890ff", "#fa8c16", "#13a8a8", "#52c41a", "#6128ff", "#d73843", "#8c8c8c", "#096dd9"];

/** 折线型图例图标（短横线内嵌圆点），波形图与逻辑图共用。 */
export const CHART_LEGEND_ICON = "path://M0 5 L20 5 L20 7 L0 7 Z M10 2 A4 4 0 1 0 10 10 A4 4 0 1 0 10 2 Z";

/** 按序号取色（循环复用）。 */
export function colorAt(index: number): string {
	return CHART_PALETTE[Math.max(0, index) % CHART_PALETTE.length];
}
