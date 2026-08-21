import {
	createWaveformExportArtifact,
	type WaveformExportOptions,
	type WaveformExportResult,
} from "../features/waveform/export";
import type { WaveformDataset } from "../shared/waveform";

/** 创建波形导出文件并通过浏览器触发下载。 */
export async function exportWaveformDatasets(
	datasets: WaveformDataset[],
	options: WaveformExportOptions = {},
): Promise<WaveformExportResult> {
	const artifact = await createWaveformExportArtifact(datasets, options);
	downloadBlob(artifact.fileName, artifact.blob);
	return artifact;
}

export function downloadTextFile(fileName: string, content: string, type: string): void {
	downloadBlob(fileName, new Blob([content], { type }));
}

function downloadBlob(fileName: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
