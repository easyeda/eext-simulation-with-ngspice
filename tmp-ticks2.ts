/* 实验：ECharts value 轴刻度在 min/max/interval/minInterval 组合下的实际值。 */

import * as echarts from "echarts";

function renderTicks(label: string, axisOpt: Record<string, unknown>): void {
	const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 600, height: 400 });
	chart.setOption({
		xAxis: { type: "value", min: 0, max: 1 },
		yAxis: {
			type: "value",
			min: -0.125,
			max: 1.125,
			splitNumber: 4,
			axisLabel: { formatter: (v: number) => String(v) },
			...axisOpt,
		},
		series: [{ type: "line", data: [[0, 0], [1, 1]] }],
	});
	const svg = chart.renderToSVGString();
	chart.dispose();
	// 解析 y 轴刻度的数字文本
	const labels = [...svg.matchAll(/<text[^>]*>(-?\d+\.?\d*)<\/text>/g)]
		.map((m) => m[1])
		.filter((t) => t !== "0" && t !== "1") // 排除 x 轴 0/1
		.slice(0, 10);
	console.log(`${label}: [${labels.join(", ")}]`);
}

renderTicks("A interval=0.5", { interval: 0.5 });
renderTicks("B minInterval=0.5 only", { minInterval: 0.5 });
renderTicks("C no interval (current after fix?)", {});
renderTicks("D interval=0.5 no splitNumber", { interval: 0.5, splitNumber: undefined });

// ECharts 是否真的尊重 interval option？换个方式：拿到轴 scale 的 ticks。
function renderTicksViaModel(label: string, axisOpt: Record<string, unknown>): void {
	const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 600, height: 400 });
	chart.setOption({
		xAxis: { type: "value", min: 0, max: 1 },
		yAxis: { type: "value", min: -0.125, max: 1.125, splitNumber: 4, ...axisOpt },
		series: [{ type: "line", data: [[0, 0], [1, 1]] }],
	});
	// 通过 convertToPixel 反推刻度：测 0 和 0.5 的像素位置是否有意义
	const px0 = chart.convertToPixel({ yAxisIndex: 0 }, 0);
	const px05 = chart.convertToPixel({ yAxisIndex: 0 }, 0.5);
	const px1 = chart.convertToPixel({ yAxisIndex: 0 }, 1);
	const pxMin = chart.convertToPixel({ yAxisIndex: 0 }, -0.125);
	const pxMax = chart.convertToPixel({ yAxisIndex: 0 }, 1.125);
	console.log(`${label}: px(-0.125)=${pxMin} px(0)=${px0} px(0.5)=${px05} px(1)=${px1} px(1.125)=${pxMax}`);
	chart.dispose();
}

renderTicksViaModel("M1 interval=0.5", { interval: 0.5 });
renderTicksViaModel("M2 minInterval=0.5", { minInterval: 0.5 });
renderTicksViaModel("M3 nothing", {});

process.exit(0);
