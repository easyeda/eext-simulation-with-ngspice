export interface EdaMessageBusPort {
	rpcServicePublic(topic: string, handler: () => unknown): void;
	rpcCallPublic(topic: string, payload: unknown, timeoutMs: number): Promise<unknown>;
	subscribePublic(topic: string, handler: (value: unknown) => void): void;
	publishPublic(topic: string, value: unknown): void;
}

export interface EdaIFramePort {
	openIFrame(
		path: string,
		width: number,
		height: number,
		id: string,
		options: {
			maximizeButton: boolean;
			minimizeButton: boolean;
			title: string;
		},
	): Promise<void>;
}

export interface EdaSimulationEventPort {
	addSimulationEnginePullEventListener(
		id: string,
		scope: string,
		listener: (eventType: string, props: unknown) => void | Promise<void>,
	): void;
}

export interface EdaHostPort {
	sys_MessageBus?: EdaMessageBusPort;
	sys_IFrame?: EdaIFramePort;
	sch_Event?: EdaSimulationEventPort;
}

declare const eda: unknown;

/** 将无类型的 EasyEDA 全局对象隔离在协议层和应用层之外。 */
export function resolveEdaHost(): EdaHostPort | null {
	const candidates: unknown[] = [];
	try {
		if (typeof eda !== "undefined") candidates.push(eda);
	}
	catch {
		// 独立浏览器测试环境不会定义 EasyEDA 全局对象。
	}
	try {
		candidates.push((globalThis as { eda?: unknown }).eda);
	}
	catch {
		// 忽略当前上下文无法访问的宿主全局对象。
	}
	try {
		const parent = globalThis.window?.parent;
		if (parent) candidates.push((parent as unknown as { eda?: unknown }).eda);
	}
	catch {
		// 跨域 iframe 可能拒绝访问父窗口。
	}
	for (const candidate of candidates) {
		if (candidate && typeof candidate === "object") return candidate as EdaHostPort;
	}
	return null;
}

export function resolveMessageBus(): EdaMessageBusPort | null {
	const bus = resolveEdaHost()?.sys_MessageBus;
	return bus
		&& typeof bus.subscribePublic === "function"
		&& typeof bus.rpcCallPublic === "function"
		&& typeof bus.rpcServicePublic === "function"
		&& typeof bus.publishPublic === "function"
		? bus
		: null;
}
