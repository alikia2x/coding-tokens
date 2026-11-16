export interface WindsurfInteraction {
	prompt?: string;
	completion?: string;
	timestamp?: number;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
}

export interface WindsurfChatState {
	conversationId: string;
	model: string;
	cwd?: string | null;
	filePath: string;
	mtimeMs: number;
	interactions: WindsurfInteraction[];
}
