import type { SpiceCommandType } from "../shared/analysis-types";
import { getNumberLocale, t } from "../shared/i18n";

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	}[character] || character));
}

export function formatInteger(value: number): string {
	return Number.isFinite(value) ? Math.round(value).toLocaleString(getNumberLocale()) : "0";
}

export function analysisTitle(type: SpiceCommandType): string {
	if (type === "ac") return t("analysis.title.ac");
	if (type === "dc") return t("analysis.title.dc");
	return t("analysis.title.transient");
}

export function formatNumber(value: number, digits = 6): string {
	if (!Number.isFinite(value)) return "-";
	const absolute = Math.abs(value);
	if (absolute !== 0 && (absolute < 1e-4 || absolute >= 1e6)) return value.toExponential(4);
	return Number(value.toPrecision(digits)).toLocaleString(getNumberLocale(), { maximumSignificantDigits: digits });
}

export function normalizeMeasurementId(value: string): string {
	return value.trim().toLowerCase();
}

export function prettyMeasurementId(value: string): string {
	return value.replace(/_/g, " ");
}

/** 测量项展示名，相位测量等带单位时追加 " (deg)" 之类标注。 */
export function measurementLabelWithUnit(label: string, unit?: string): string {
	return unit ? `${label} (${unit})` : label;
}
