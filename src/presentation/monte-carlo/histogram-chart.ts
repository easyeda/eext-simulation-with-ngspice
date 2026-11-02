import type { EChartsOption } from 'echarts';
import { t } from '../../shared/i18n';
import { ChartBase } from '../components/chart-kit/echarts-chart-base';
import { formatCanvasNumber, formatInteger } from '../components/chart-kit/axis-format';
import { measureChartText } from '../components/chart-kit/text-metrics';
import { buildHistogramBins, type HistogramMeasurement } from '../../features/monte-carlo/histogram';

export type HistogramYAxisMode = 'count' | 'percent';

/** Monte Carlo 直方图的 ECharts 展示适配器。 */
export class MonteCarloHistogramChart extends ChartBase {
	private measurement: HistogramMeasurement | null = null;
	private yAxisMode: HistogramYAxisMode = 'count';
	private specVisible = true;
	private selectedBinIndex: number | null = null;

	constructor(
		element: HTMLElement,
		titleElement: HTMLElement,
		badgesElement: HTMLElement,
	) {
		// #histogramChart 初始 hidden,兜底 1×1;显示后由 resize() 更新真实尺寸。
		super(element, titleElement, badgesElement, { fallbackWidth: 1, fallbackHeight: 1 });
		this.chart.on('click', (event: { dataIndex?: number }) => {
			if (typeof event.dataIndex !== 'number') return;
			this.selectedBinIndex = event.dataIndex;
			this.render();
		});
		this.renderEmpty();
	}

	setMeasurement(measurement: HistogramMeasurement | null) {
		this.measurement = measurement;
		this.selectedBinIndex = null;
		if (!measurement) {
			this.renderEmpty();
			return;
		}
		this.render();
	}

	setYAxisMode(mode: HistogramYAxisMode) {
		this.yAxisMode = mode;
		this.render();
	}

	setSpecVisible(visible: boolean) {
		this.specVisible = visible;
		this.render();
	}

	fit() {
		this.selectedBinIndex = null;
		this.render();
	}

	protected hasContent(): boolean {
		return this.measurement !== null;
	}

	protected renderEmpty(): void {
		this.setChartMeta(t('chart.histogramTitle'), `<span class="chart-meta">${t('chart.histogramWaiting')}</span>`);
		this.renderEmptyChart(t('chart.histogramEmpty'));
	}

	protected render(): void {
		const measurement = this.measurement;
		if (!measurement) {
			this.renderEmpty();
			return;
		}
		const bins = buildHistogramBins(measurement.values);
		if (!bins.length) {
			this.renderEmpty();
			return;
		}
		const total = measurement.values.length;
		const selectedBinIndex = this.selectedBinIndex;
		const minimum = bins[0].lower;
		const maximum = bins[bins.length - 1].upper;
		const span = maximum - minimum;
		const axisPadding = span > 0 ? span * 0.025 : 1;
		// 顶部留白：纵轴上限 = 峰值 × 7/6，柱区占 6/7、上方空 1/7，观感不顶格。
		const peakValue = Math.max(...bins.map((bin) => this.yAxisMode === 'count' ? bin.count : bin.count / total * 100));
		const yAxisMax = peakValue * 7 / 6;

		this.setChartMeta(
			t('chart.distributionTitle', measurement.label),
			`<span class="chart-meta">${t('chart.histogramMeta', formatInteger(total), bins.length)}</span>`,
		);

		// markLine 默认标签显示原始数值，这里显式格式化，避免长数字画出画布。
		const meanLabel = t('chart.mean', formatCanvasNumber(measurement.summary.mean));
		const markLines: any[] = [{
			xAxis: measurement.summary.mean,
			name: meanLabel,
			lineStyle: { color: '#d46b08', width: 2 },
			label: { color: '#ad4e00', formatter: meanLabel },
		}];
		if (this.specVisible && typeof measurement.spec?.min === 'number') {
			markLines.push({ xAxis: measurement.spec.min, name: 'LSL', lineStyle: { color: '#cf1322', type: 'dashed' }, label: { color: '#a8071a', formatter: 'LSL' } });
		}
		if (this.specVisible && typeof measurement.spec?.max === 'number') {
			markLines.push({ xAxis: measurement.spec.max, name: 'USL', lineStyle: { color: '#cf1322', type: 'dashed' }, label: { color: '#a8071a', formatter: 'USL' } });
		}

		const option: EChartsOption = {
			backgroundColor: '#ffffff',
			animation: true,
			animationDuration: 260,
			tooltip: {
				trigger: 'item',
				confine: true,
				backgroundColor: '#ffffff',
				borderColor: '#d9d9d9',
				textStyle: { color: '#333333', fontSize: 12 },
				formatter: (params: any) => {
					const bin = bins[params.dataIndex];
					return t(
						'chart.histogramTooltip',
						formatCanvasNumber(bin.lower),
						formatCanvasNumber(bin.upper),
						bin.count,
						formatCanvasNumber(bin.count / total * 100),
					);
				},
			},
			// 左侧留白按纵轴标签实际宽度算，数值再长也不会被画出画布。
			grid: { show: true, left: histogramLeftInset(yAxisMax), right: 32, top: 34, bottom: 56, borderColor: '#b8c0cc', borderWidth: 1 },
			xAxis: {
				type: 'value',
				min: minimum - axisPadding,
				max: maximum + axisPadding,
				name: measurement.unit ? `${measurement.label} (${measurement.unit})` : measurement.label,
				nameLocation: 'middle',
				nameGap: 34,
				axisLabel: { color: '#5f6874', hideOverlap: true, formatter: (value: number) => formatCanvasNumber(value) },
				axisLine: { lineStyle: { color: '#87909e' } },
				splitLine: { show: false },
			},
			yAxis: {
				type: 'value',
				name: this.yAxisMode === 'count' ? t('chart.sampleCountAxis') : t('chart.percentAxis'),
				min: 0,
				max: yAxisMax,
				minInterval: this.yAxisMode === 'count' ? 1 : undefined,
				axisLabel: { color: '#5f6874', formatter: (value: number) => formatCanvasNumber(value) },
				axisLine: { show: true, lineStyle: { color: '#87909e' } },
				splitLine: { lineStyle: { color: '#e3e7ec' } },
			},
			series: [{
				type: 'bar',
				barWidth: '60%',
				data: bins.map((bin, index) => ({
					value: [(bin.lower + bin.upper) / 2, this.yAxisMode === 'count' ? bin.count : bin.count / total * 100],
					itemStyle: {
						color: index === selectedBinIndex ? '#1890ff' : '#40a9ff',
						borderColor: index === selectedBinIndex ? '#096dd9' : '#1890ff',
						borderWidth: index === selectedBinIndex ? 2 : 1,
					},
				})),
				markLine: { silent: true, symbol: 'none', label: { fontSize: 10 }, data: markLines },
			}],
		};
		this.chart.setOption(option, true);
	}
}

/** 纵轴标签最长值（0 与上限）决定左边距，至少保留 68px。 */
function histogramLeftInset(yAxisMax: number): number {
	const labelWidth = Math.max(
		measureChartText(formatCanvasNumber(0)),
		measureChartText(formatCanvasNumber(yAxisMax)),
	);
	return Math.ceil(Math.max(68, labelWidth + 26));
}
