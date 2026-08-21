import type { NetlistImportMessage } from "./messages";

/** 仅用于合并同一 EDA 事件产生的 RPC 消息和重试广播。 */
export function netlistImportKey(imported: NetlistImportMessage): string {
	return [
		imported.protocolVersion,
		imported.fileName,
		imported.netlist.length,
		imported.netlist,
		JSON.stringify(imported.analysis),
		JSON.stringify(imported.defaultVisibleProbes),
	].join("|");
}
