const FONT_SIZE = 12;
const measured = new Map<string, number>();
let measureContext: CanvasRenderingContext2D | null | undefined;
// 缓存键分隔符：普通文本不会包含 NUL 字符，避免不同字号/文本碰撞。
const KEY_SEPARATOR = String.fromCharCode(0);

/** 量取图表文字像素宽度，供坐标轴预留边距。 */
export function measureChartText(text: string, fontSize = FONT_SIZE): number {
	const key = `${fontSize}${KEY_SEPARATOR}${text}`;
	const cached = measured.get(key);
	if (cached !== undefined) return cached;
	if (measureContext === undefined) {
		measureContext = typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
	}
	let width: number;
	if (measureContext) {
		// 与图表默认文字字体保持一致：Windows 为微软雅黑，其余平台为 sans-serif。
		const family = /^Win/.test(navigator.platform || "") ? "Microsoft YaHei" : "sans-serif";
		measureContext.font = `${fontSize}px ${family}`;
		width = measureContext.measureText(text).width;
	}
	else {
		width = text.length * fontSize * 0.62;
	}
	measured.set(key, width);
	return width;
}
