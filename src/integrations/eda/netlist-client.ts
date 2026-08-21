import {
	NETLIST_TOPIC,
	REQUEST_NETLIST_TOPIC,
	parseNetlistImportMessage,
	type NetlistImportMessage,
} from "./messages";
import { resolveMessageBus } from "./host";

export interface NetlistClientHandlers {
	onMessage(message: NetlistImportMessage, channel: "broadcast" | "rpc"): void;
	onConnected(): void;
	onUnavailable(): void;
	onError(error: unknown): void;
}

/** 封装 iframe 对 EDA MessageBus 的订阅、首次拉取和协议解析。 */
export function connectNetlistClient(handlers: NetlistClientHandlers): void {
	const bus = resolveMessageBus();
	if (!bus) {
		handlers.onUnavailable();
		return;
	}
	try {
		bus.subscribePublic(NETLIST_TOPIC, (value: unknown) => {
			const message = parseNetlistImportMessage(value);
			if (message) handlers.onMessage(message, "broadcast");
		});
		// bus.rpcCallPublic(REQUEST_NETLIST_TOPIC, undefined, 800)
		// 	.then((value: unknown) => {
		// 		const message = parseNetlistImportMessage(value);
		// 		if (message) handlers.onMessage(message, "rpc");
		// 	})
		// 	.catch(() => {
		// 		// 首次打开时 EDA 可能还没有可拉取的网表。
		// 	});
		handlers.onConnected();
	}
	catch (error) {
		handlers.onError(error);
	}
}
