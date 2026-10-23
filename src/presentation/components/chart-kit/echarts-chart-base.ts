import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import { t } from "../../../shared/i18n";
import { escapeHtml } from "../../utils/format";

export type ChartDisplayMode = "line" | "points" | "both";
export type ChartCursorMode = "follow" | "cursor";

export const displayModeLabelKeys: Record<ChartDisplayMode, string> = {
	line: "display.line",
	points: "display.points",
	both: "display.both",
};

export const cursorModeLabelKeys: Record<ChartCursorMode, string> = {
	follow: "cursor.follow",
	cursor: "cursor.cursor",
};

export interface ChartBaseOptions {
	/** 容器不可见(量不到尺寸)时 echarts.init 的兜底宽高;显示后由 resize() 修正。 */
	fallbackWidth?: number;
	fallbackHeight?: number;
}

/**
 * 画布共享基类:
 */
export abstract class ChartBase {
	protected readonly chart: ECharts;
	protected displayMode: ChartDisplayMode = "line";
	protected cursorMode: ChartCursorMode = "follow";

	protected constructor(
		protected readonly el: HTMLElement,
		protected readonly titleElement: HTMLElement | null,
		protected readonly badgesElement: HTMLElement | null,
		options: ChartBaseOptions = {},
	) {
		const width = el.clientWidth || el.offsetWidth || options.fallbackWidth || 600;
		const height = el.clientHeight || el.offsetHeight || options.fallbackHeight || 400;
		this.chart = echarts.init(el, null, { renderer: "canvas", width, height });
		window.addEventListener("resize", () => this.resize());
	}

	resize(): void {
		const width = this.el.clientWidth;
		const height = this.el.clientHeight;
		if (!width || !height) return;
		this.chart.resize({ width, height });
		this.afterResize();
	}

	refreshLocale(): void {
		this.onLocaleChanged();
		if (this.hasContent()) this.render();
		else this.renderEmpty();
	}

	cycleDisplayMode(): string {
		const modes: ChartDisplayMode[] = ["line", "points", "both"];
		this.displayMode = modes[(modes.indexOf(this.displayMode) + 1) % modes.length];
		if (this.hasContent()) this.render();
		return t(displayModeLabelKeys[this.displayMode]);
	}

	getDisplayLabel(): string {
		return t(displayModeLabelKeys[this.displayMode]);
	}

	cycleCursorMode(): string {
		this.cursorMode = this.cursorMode === "follow" ? "cursor" : "follow";
		this.onCursorModeChanged();
		if (this.hasContent()) this.render();
		else this.renderEmpty();
		return t(cursorModeLabelKeys[this.cursorMode]);
	}

	getCursorModeLabel(): string {
		return t(cursorModeLabelKeys[this.cursorMode]);
	}

	/** 标题与徽标区(元素存在才写;徽标为可信 HTML,由子类自行转义内容)。 */
	protected setChartMeta(title: string, badgeHtml: string): void {
		if (this.titleElement) this.titleElement.textContent = title;
		if (this.badgesElement) this.badgesElement.innerHTML = badgeHtml;
	}

	/** 空态占位:灰底 + 隐藏轴 + 居中灰字;badgeText 提供时同步徽标区。 */
	protected renderEmptyChart(emptyText: string, badgeText?: string): void {
		if (badgeText !== undefined && this.badgesElement) {
			this.badgesElement.innerHTML = `<span class="chart-meta">${escapeHtml(badgeText)}</span>`;
		}
		this.chart.setOption({
			backgroundColor: "#f7f8fa",
			xAxis: { show: false },
			yAxis: { show: false },
			series: [],
			graphic: {
				type: "text",
				left: "center",
				top: "middle",
				style: { text: emptyText, fill: "#868686", font: "12px Microsoft YaHei" },
			},
		} satisfies EChartsOption, true);
	}

	/** 当前是否有内容可渲染(决定 refreshLocale/模式切换走 render 还是 renderEmpty)。 */
	protected abstract hasContent(): boolean;

	protected abstract render(): void;

	protected abstract renderEmpty(): void;

	/** resize 后的画布专属收尾(游标重算/覆盖层同步),缺省无操作。 */
	protected afterResize(): void {}

	/** 游标模式切换时的画布专属收尾(清圆点/定位游标),缺省无操作。 */
	protected onCursorModeChanged(): void {}

	/** 语言切换时的画布专属收尾(面板 aria 文案等),缺省无操作。 */
	protected onLocaleChanged(): void {}
}
