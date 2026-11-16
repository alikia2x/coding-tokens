export interface CursorBubbleTokenUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export interface CursorBubble {
	id?: string;
	type?: "user" | "ai" | "agent" | string;
	role?: "user" | "assistant" | "system" | string;
	text?: string;
	rawText?: string;
	modelName?: string;
	model?: string;
	timestamp?: number;
	createdAt?: number;
	tokenUsage?: CursorBubbleTokenUsage;
	usage?: CursorBubbleTokenUsage;
	toolCalls?: Array<{
		name?: string;
		input?: unknown;
		output?: unknown;
		callId?: string;
		status?: string;
	}>;
	isSubagent?: boolean;
}

export interface CursorModelConfig {
	modelName?: string;
	maxMode?: boolean;
}

export interface CursorComposerData {
	_v?: number;
	composerId: string;
	createdAt?: number;
	unifiedMode?: "agent" | "edit" | "chat" | string;
	forceMode?: string;
	modelConfig?: CursorModelConfig;
	model?: string;
	text?: string;
	richText?: string;
	conversationMap?: Record<string, CursorBubble> | CursorBubble[];
	bubbles?: CursorBubble[];
	fullConversationHeadersOnly?: unknown[];
	usageData?: CursorBubbleTokenUsage;
}

export interface CursorWorkspaceComposerSummary {
	composerId: string;
	createdAt?: number;
	unifiedMode?: string;
	totalLinesAdded?: number;
	totalLinesRemoved?: number;
}
