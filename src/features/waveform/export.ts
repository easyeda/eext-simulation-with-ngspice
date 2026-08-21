import JSZip from 'jszip';
import type { WaveformDataset, WaveformTrace } from '../../shared/waveform';

export interface WaveformExportOptions {
	baseName?: string;
	generatedAt?: Date;
}

export interface WaveformExportResult {
	fileName: string;
	datasetCount: number;
	traceCount: number;
}

export interface WaveformExportArtifact extends WaveformExportResult {
	blob: Blob;
}

export async function createWaveformExportArtifact(
	datasets: WaveformDataset[],
	options: WaveformExportOptions = {},
): Promise<WaveformExportArtifact> {
	if (!datasets.length) throw new Error('No waveform datasets are available');

	const baseName = sanitizeFileName(options.baseName || 'waveform');
	const timestamp = (options.generatedAt || new Date()).toISOString().replace(/[:.]/g, '-');
	const traceCount = datasets.reduce((total, dataset) => total + dataset.traces.length, 0);

	if (datasets.length === 1) {
		const fileName = `${baseName}-${timestamp}.csv`;
		const blob = new Blob([waveformDatasetToCsv(datasets[0])], { type: 'text/csv;charset=utf-8' });
		return { fileName, blob, datasetCount: 1, traceCount };
	}

	const zip = new JSZip();
	datasets.forEach((dataset, index) => {
		const datasetName = sanitizeFileName(
			`${String(index + 1).padStart(2, '0')}-${dataset.productAnalysisType}-${dataset.spiceCommandType}-${dataset.title || dataset.id}`,
		);
		zip.file(`${datasetName}.csv`, waveformDatasetToCsv(dataset));
	});
	const fileName = `${baseName}-${timestamp}.zip`;
	const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
	return { fileName, blob, datasetCount: datasets.length, traceCount };
}

export function waveformDatasetToCsv(dataset: WaveformDataset): string {
	const content = tracesShareXAxis(dataset.traces)
		? datasetToWideCsv(dataset)
		: datasetToLongCsv(dataset);
	return `\uFEFF${content}`;
}

function datasetToWideCsv(dataset: WaveformDataset): string {
	const xHeader = axisHeader(dataset.xAxis.name || 'x', dataset.xAxis.unit);
	const headers = [xHeader, ...dataset.traces.map((trace) => axisHeader(trace.name, trace.unit))];
	const rowCount = dataset.traces[0]?.points.length || 0;
	const rows = [headers.map(csvCell).join(',')];
	for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
		rows.push([
			dataset.traces[0].points[rowIndex][0],
			...dataset.traces.map((trace) => trace.points[rowIndex][1]),
		].map(csvCell).join(','));
	}
	return rows.join('\r\n');
}

function datasetToLongCsv(dataset: WaveformDataset): string {
	const headers = [
		'datasetId',
		'productAnalysisType',
		'spiceCommandType',
		'traceId',
		'traceName',
		'xName',
		'xUnit',
		'xValue',
		'yUnit',
		'yValue',
	];
	const rows = [headers.join(',')];
	for (const trace of dataset.traces) {
		for (const [x, y] of trace.points) {
			rows.push([
				dataset.id,
				dataset.productAnalysisType,
				dataset.spiceCommandType,
				trace.id,
				trace.name,
				dataset.xAxis.name,
				dataset.xAxis.unit,
				x,
				trace.unit,
				y,
			].map(csvCell).join(','));
		}
	}
	return rows.join('\r\n');
}

function tracesShareXAxis(traces: WaveformTrace[]): boolean {
	if (!traces.length) return true;
	const reference = traces[0].points;
	return traces.every((trace) => (
		trace.points.length === reference.length
		&& trace.points.every((point, index) => Object.is(point[0], reference[index][0]))
	));
}

function axisHeader(name: string, unit: string): string {
	return unit ? `${name} (${unit})` : name;
}

function csvCell(value: string | number): string {
	const text = typeof value === 'number' ? String(value) : value;
	return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function sanitizeFileName(value: string): string {
	const sanitized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/\s+/g, '-');
	return sanitized.slice(0, 120) || 'waveform';
}
