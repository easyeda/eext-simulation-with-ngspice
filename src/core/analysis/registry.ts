import type {
	AnalysisArtifact,
	AnalysisExecution,
	AnalysisHandler,
	AnalysisHandlerResult,
	AnalysisRequest,
} from "./contracts";

export class AnalysisRegistry<
	TRequest extends AnalysisRequest = AnalysisRequest,
	TArtifact extends AnalysisArtifact = AnalysisArtifact,
> {
	private readonly handlers = new Map<TRequest["analysisType"], AnalysisHandler<AnalysisRequest, TArtifact>>();

	constructor(private readonly engine: { name: string; resultProtocolVersion: number }) {}

	register<TRegisteredRequest extends TRequest>(
		handler: AnalysisHandler<TRegisteredRequest, TArtifact>,
	): this {
		if (this.handlers.has(handler.type)) throw new Error(`Analysis handler already registered: ${handler.type}`);
		this.handlers.set(
			handler.type,
			handler as unknown as AnalysisHandler<AnalysisRequest, TArtifact>,
		);
		return this;
	}

	has(type: string): boolean {
		return this.handlers.has(type);
	}

	types(): string[] {
		return [...this.handlers.keys()];
	}

	async execute(request: TRequest): Promise<AnalysisExecution<TRequest["analysisType"], TArtifact>> {
		const handler = this.handlers.get(request.analysisType);
		if (!handler) throw new Error(`Unsupported analysis type: ${request.analysisType}`);
		const startedAt = Date.now();
		const executionId = createExecutionId(request.analysisType, startedAt);
		let result: AnalysisHandlerResult<TArtifact>;
		try {
			result = await handler.execute(request);
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				ok: false,
				artifacts: [],
				logs: [],
				error: message,
			};
		}
		const finishedAt = Date.now();
		return {
			protocolVersion: 1,
			analysisType: request.analysisType,
			...result,
			metadata: {
				executionId,
				startedAt,
				finishedAt,
				durationMs: Math.max(0, finishedAt - startedAt),
				engine: this.engine.name,
				engineResultProtocolVersion: this.engine.resultProtocolVersion,
				inputFingerprint: fingerprint(`${request.analysisType}\n${request.netlist}\n${stableJson(request.options)}`),
			},
		};
	}
}

function createExecutionId(type: string, timestamp: number): string {
	const random = Math.random().toString(36).slice(2, 10);
	return `${type}-${timestamp.toString(36)}-${random}`;
}

/** 用于关联结果与请求的稳定非加密指纹。 */
function fingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function stableJson(value: unknown): string {
	return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortValue);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, item]) => [key, sortValue(item)]));
}
