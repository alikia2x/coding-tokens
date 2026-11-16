export interface CopilotToolCall {
	name?: string;
	toolId?: string;
	callId?: string;
	input?: unknown;
	result?: unknown;
	status?: string;
}

export interface CopilotToolRound {
	toolCalls?: CopilotToolCall[];
	call?: CopilotToolCall;
	name?: string;
	input?: unknown;
	result?: unknown;
}

export interface CopilotRequest {
	timestamp?: number;
	modelId?: string;
	message?:
		| {
				text?: string;
				[key: string]: unknown;
		  }
		| string;
	response?:
		| Array<{
				value?: string;
				[key: string]: unknown;
		  }>
		| {
				value?: string;
				[key: string]: unknown;
		  }
		| string;
	result?: {
		metadata?: {
			toolCallRounds?: CopilotToolRound[];
			tokenUsage?: {
				inputTokens?: number;
				outputTokens?: number;
				cacheReadTokens?: number;
				cacheWriteTokens?: number;
				reasoningTokens?: number;
			};
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
	tokenUsage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
	};
}

export interface CopilotChatSessionData {
	version?: number;
	sessionId?: string;
	id?: string;
	creationDate?: number;
	lastMessageDate?: number;
	responderUsername?: string;
	requesterUsername?: string;
	title?: string;
	requests?: CopilotRequest[];
}
