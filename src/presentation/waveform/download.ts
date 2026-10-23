import {
	createWaveformExportArtifact,
	type WaveformExportOptions,
	type WaveformExportResult,
} from "../../features/waveform/export";
import type { WaveformDataset } from "../../shared/waveform";
import { downloadBlob } from "../utils/download";

/** 创建波形导出文件并通过浏览器触发下载(波形域专属桥接,通用下载工具在 utils/download)。 */
export async function exportWaveformDatasets(
	datasets: WaveformDataset[],
	options: WaveformExportOptions = {},
): Promise<WaveformExportResult> {
	const artifact = await createWaveformExportArtifact(datasets, options);
	downloadBlob(artifact.fileName, artifact.blob);
	return artifact;
}
