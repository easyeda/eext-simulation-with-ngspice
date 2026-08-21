import type { WorstCaseResult } from "../../features/worst-case/types";
import type { ToleranceSource } from "../../shared/variation";
import { t } from "../../shared/i18n";
import { formatNumber } from "../format";

export function formatAssignments(assignments: Record<string, number>): string {
	return Object.entries(assignments).map(([name, value]) => `${name}=${formatNumber(value)}`).join(", ");
}

export function formatTolerance(tolerance: ToleranceSource): string {
	if (tolerance.kind === "relative") return `-${formatNumber(tolerance.lowerPercent)}% / +${formatNumber(tolerance.upperPercent)}%`;
	if (tolerance.kind === "absolute") return `-${formatNumber(tolerance.lowerDelta)} / +${formatNumber(tolerance.upperDelta)}${tolerance.unit ? ` ${tolerance.unit}` : ""}`;
	return t("wca.resolvedBounds");
}

export function worstCaseRunLabel(kind: WorstCaseResult["runs"][number]["kind"], parameterId?: string): string {
	if (kind === "nominal") return t("wca.nominal");
	if (kind === "worst-low") return t("wca.worstLow");
	if (kind === "worst-high") return t("wca.worstHigh");
	return `${parameterId || "-"} · ${kind === "parameter-min" ? t("wca.minimum") : t("wca.maximum")}`;
}
