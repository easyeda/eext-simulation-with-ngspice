export interface AnalysisRequest<TType extends string = string, TOptions = unknown> {
	analysisType: TType;
	netlist: string;
	options: TOptions;
}

export interface AnalysisArtifact<TKind extends string = string, TPayload = unknown> {
	kind: TKind;
	payload: TPayload;
}

export interface AnalysisExecutionMetadata {
	executionId: string;
	startedAt: number;
	finishedAt: number;
	durationMs: number;
	engine: string;
	engineResultProtocolVersion: number;
	inputFingerprint: string;
}

export interface AnalysisExecution<TType extends string = string, TArtifact extends AnalysisArtifact = AnalysisArtifact> {
	protocolVersion: 1;
	analysisType: TType;
	ok: boolean;
	artifacts: TArtifact[];
	logs: string[];
	error?: string;
	metadata: AnalysisExecutionMetadata;
}

export type AnalysisHandlerResult<TArtifact extends AnalysisArtifact = AnalysisArtifact> =
	Omit<AnalysisExecution<string, TArtifact>, "protocolVersion" | "analysisType" | "metadata">;

export interface AnalysisHandler<
	TRequest extends AnalysisRequest = AnalysisRequest,
	TArtifact extends AnalysisArtifact = AnalysisArtifact,
> {
	readonly type: TRequest["analysisType"];
	execute(request: TRequest): Promise<AnalysisHandlerResult<TArtifact>>;
}
