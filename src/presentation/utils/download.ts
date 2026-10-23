/** 通用浏览器下载工具。 */

export function downloadTextFile(fileName: string, content: string, type: string): void {
	downloadBlob(fileName, new Blob([content], { type }));
}

export function downloadBlob(fileName: string, blob: Blob): void {
	const url = URL.createObjectURL(blob);
	const anchor = document.createElement("a");
	anchor.href = url;
	anchor.download = fileName;
	document.body.appendChild(anchor);
	anchor.click();
	anchor.remove();
	URL.revokeObjectURL(url);
}
