import * as echarts from 'echarts';
import type { ECharts, EChartsOption } from 'echarts';
import { getNumberLocale, t } from '../../shared/i18n';
import { buildHistogramBins, type HistogramMeasurement } from '../../features/monte-carlo/histogram';

export type HistogramYAxisMode = 'count' | 'percent';

/** Monte Carlo 直方图的 ECharts 展示适配器。 */
export class MonteCarloHistogramChart {
	private readonly chart: ECharts;
	private measurement: HistogramMeasurement | null = null;
	private yAxisMode: HistogramYAxisMode = 'count';
	private specVisible = true;
	private selectedBinIndex: number | null = null;

	constructor(
		private readonly element: HTMLElement,
		private readonly titleElement: HTMLElement,
		private readonly badgesElement: HTMLElement,
	) {
		this.chart = echarts.init(element, null, {
			renderer: 'canvas',
			width: element.clientWidth || 1,
			height: element.clientHeight || 1,
		});
		this.chart.on('click', (event: { dataIndex?: number }) => {
			if (typeof event.dataIndex !== 'number') return;
			this.selectedBinIndex = event.dataIndex;
			this.render();
		});
		window.addEventListener('resize', () => this.resize());
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

	resize() {
		const width = this.element.clientWidth;
		const height = this.element.clientHeight;
		if (!width || !height) return;
		this.chart.resize({ width, height });
	}

	refreshLocale() {
		if (this.measurement) this.render();
		else this.renderEmpty();
	}

	private renderEmpty() {
		this.titleElement.textContent = t('chart.histogramTitle');
		this.badgesElement.innerHTML = `<span class="chart-meta">${t('chart.histogramWaiting')}</span>`;
		this.chart.setOption({
			backgroundColor: '#f7f8fa',
			xAxis: { show: false },
			yAxis: { show: false },
			series: [],
			graphic: {
				type: 'text',
				left: 'center',
				top: 'middle',
				style: { text: t('chart.histogramEmpty'), fill: '#868686', font: '12px Microsoft YaHei' },
			},
		} satisfies EChartsOption, true);
	}

	private render() {
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

		this.titleElement.textContent = t('chart.distributionTitle', measurement.label);
		this.badgesElement.innerHTML = `<span class="chart-meta">${t('chart.histogramMeta', formatInteger(total), bins.length)}</span>`;

		const markLines: any[] = [{
			xAxis: measurement.summary.mean,
			name: t('chart.mean', formatNumber(measurement.summary.mean)),
			lineStyle: { color: '#d46b08', width: 2 },
			label: { color: '#ad4e00' },
		}];
		if (this.specVisible && typeof measurement.spec?.min === 'number') {
			markLines.push({ xAxis: measurement.spec.min, name: 'LSL', lineStyle: { color: '#cf1322', type: 'dashed' }, label: { color: '#a8071a' } });
		}
		if (this.specVisible && typeof measurement.spec?.max === 'number') {
			markLines.push({ xAxis: measurement.spec.max, name: 'USL', lineStyle: { color: '#cf1322', type: 'dashed' }, label: { color: '#a8071a' } });
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
						formatNumber(bin.lower),
						formatNumber(bin.upper),
						bin.count,
						formatNumber(bin.count / total * 100, 3),
					);
				},
			},
			grid: { show: true, left: 68, right: 32, top: 34, bottom: 56, borderColor: '#b8c0cc', borderWidth: 1 },
			xAxis: {
				type: 'value',
				min: minimum - axisPadding,
				max: maximum + axisPadding,
				name: measurement.unit ? `${measurement.label} (${measurement.unit})` : measurement.label,
				nameLocation: 'middle',
				nameGap: 34,
				axisLabel: { color: '#5f6874', formatter: (value: number) => formatNumber(value, 5) },
				axisLine: { lineStyle: { color: '#87909e' } },
				splitLine: { show: false },
			},
			yAxis: {
				type: 'value',
				name: this.yAxisMode === 'count' ? t('chart.sampleCountAxis') : t('chart.percentAxis'),
				min: 0,
				max: yAxisMax,
				minInterval: this.yAxisMode === 'count' ? 1 : undefined,
				axisLabel: { color: '#5f6874' },
				axisLine: { show: true, lineStyle: { color: '#87909e' } },
				splitLine: { lineStyle: { color: '#e3e7ec' } },
			},
			series: [{
				type: 'bar',
				// 柱宽收敛留出间隙，柱多时保持可辨识的分箱边界。
				barWidth: '60%',
				data: bins.map((bin, index) => ({
					value: [(bin.lower + bin.upper) / 2, this.yAxisMode === 'count' ? bin.count : bin.count / total * 100],
					itemStyle: {
						// EasyEDA 规范蓝色组：品牌蓝 #1890ff / 悬停 #40a9ff / 按下 #096dd9
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

function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString(getNumberLocale()) : '0';
}

function formatNumber(value: number, digits = 6): string {
	if (!Number.isFinite(value)) return '-';
	return value.toLocaleString(getNumberLocale(), { maximumSignificantDigits: digits });
}
