import { escapeHtml } from "../../utils/format";

/**
 * 展示层通用数据表格
 * 单元格 title/类名与 HTML 转义。所有文本一律由组件转义,调用方传纯文本。
 * 现有使用方:MC 统计摘要/样本数据、WC 摘要/参数影响/运行明细、DC 扫描分组。
 * 新增底部表格必须走本组件。
 */
export interface DataTableCell {
	text: string;
	/** 单元格附加类 */
	className?: string;
	/** 悬停提示 */
	title?: string;
}

export interface DataTableRow {
	/** 行标识 */
	id?: string;
	/** 附加行类 */
	className?: string;
	/** 高亮行 */
	active?: boolean;
	cells: Array<DataTableCell | string>;
}

export interface DataTableSpec {
	/** 已本地化的表头文本,与每行 cells 一一对应。 */
	columns: string[];
	rows: DataTableRow[];
	/** 额外表类 */
	tableClassName?: string;
	/** 行点击回调 */
	onRowActivate?: (rowId: string) => void;
}

export function mountDataTable(container: HTMLElement, spec: DataTableSpec): void {
	container.innerHTML = dataTableHtml(spec);
	if (!spec.onRowActivate) return;
	container.querySelectorAll<HTMLTableRowElement>("tr[data-row-id]").forEach((row) => {
		row.addEventListener("click", () => spec.onRowActivate!(row.dataset.rowId || ""));
	});
}

export function dataTableHtml(spec: DataTableSpec): string {
	const tableClass = spec.tableClassName ? `mc-table ${spec.tableClassName}` : "mc-table";
	const header = `<thead><tr>${spec.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr></thead>`;
	const body = spec.rows.map((row) => dataTableRowHtml(row)).join("");
	return `<table class="${tableClass}">${header}<tbody>${body}</tbody></table>`;
}

function dataTableRowHtml(row: DataTableRow): string {
	const classes = [row.className ?? "", row.active ? "active" : ""].filter(Boolean).join(" ");
	const attrs = [
		classes ? ` class="${escapeHtml(classes)}"` : "",
		row.id !== undefined ? ` data-row-id="${escapeHtml(row.id)}"` : "",
	].join("");
	const cells = row.cells.map((cell) => {
		const item = typeof cell === "string" ? { text: cell } : cell;
		const cellAttrs = [
			item.className ? ` class="${escapeHtml(item.className)}"` : "",
			item.title ? ` title="${escapeHtml(item.title)}"` : "",
		].join("");
		return `<td${cellAttrs}>${escapeHtml(item.text)}</td>`;
	}).join("");
	return `<tr${attrs}>${cells}</tr>`;
}
