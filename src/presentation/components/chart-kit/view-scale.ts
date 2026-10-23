/**
 * 视口缩放/平移的纯数学（与具体画布无关）。
 * 波形图与逻辑图的滚轮缩放、拖拽平移共用；log 支持对线性轴自动退化为直通。
 */

/** 以 focus 为锚点缩放 [min,max]，scale>1 放大视野、<1 缩小。 */
export function zoomRange(
	min: number,
	max: number,
	focus: number,
	scale: number,
	isLog: boolean,
): { min: number; max: number } {
	if (!Number.isFinite(focus)) focus = (min + max) / 2;
	if (isLog) {
		const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
		const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
		const logFocus = Math.log10(Math.max(focus, Number.MIN_VALUE));
		return {
			min: 10 ** (logFocus - (logFocus - logMin) * scale),
			max: 10 ** (logFocus + (logMax - logFocus) * scale),
		};
	}
	return {
		min: focus - (focus - min) * scale,
		max: focus + (max - focus) * scale,
	};
}

/**
 * 平移 [min,max]：ratio 为拖动像素比例；x 轴拖右看历史（负向），y 轴方向相反。
 */
export function panRange(
	min: number,
	max: number,
	ratio: number,
	isLog: boolean,
	direction: "x" | "y",
): { min: number; max: number } {
	const signedRatio = direction === "x" ? -ratio : ratio;
	if (isLog) {
		const logMin = Math.log10(Math.max(min, Number.MIN_VALUE));
		const logMax = Math.log10(Math.max(max, Number.MIN_VALUE));
		const shift = signedRatio * (logMax - logMin);
		return {
			min: 10 ** (logMin + shift),
			max: 10 ** (logMax + shift),
		};
	}
	const shift = signedRatio * (max - min);
	return {
		min: min + shift,
		max: max + shift,
	};
}
