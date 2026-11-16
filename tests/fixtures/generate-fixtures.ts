import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
	toJsonlWithCorruption,
	writeJsonlFile,
	writeZstdJsonlFile,
} from "./helpers/jsonl-generator";
import {
	buildAntigravityGenMetadata,
	buildAntigravityStepPayload,
	buildAntigravityTimestampMeta,
	buildAntigravityTrajectoryMetadata,
	buildWindsurfChatStateBlob,
} from "./helpers/protobuf-builder";
import {
	closeDatabase,
	seedAntigravityDb,
	seedAntigravitySummariesDb,
	seedContinueDb,
	seedCursorDb,
	seedGooseDb,
	seedOpenCodeDb,
} from "./helpers/sqlite-fixtures";

const ROOT_FIXTURES = path.resolve(__dirname);
const HARNESSES_DIR = path.join(ROOT_FIXTURES, "harnesses");
const PLATFORMS_DIR = path.join(ROOT_FIXTURES, "platforms");

export function generateAllFixtures(): void {
	console.log("Generating canonical synthetic fixtures...");

	// ==========================================
	// 1. Claude Code
	// ==========================================
	const claudeDir = path.join(HARNESSES_DIR, "claude");
	mkdirSync(claudeDir, { recursive: true });

	const statsCache = {
		version: 2,
		lastComputedDate: "2026-03-15",
		dailyActivity: [
			{
				date: "2026-03-15",
				messageCount: 12,
				sessionCount: 2,
				toolCallCount: 4,
			},
		],
		dailyModelTokens: [
			{ date: "2026-03-15", tokensByModel: { "claude-3-7-sonnet": 35000 } },
		],
		modelUsage: {
			"claude-3-7-sonnet": {
				inputTokens: 25000,
				outputTokens: 8000,
				cacheReadInputTokens: 150000,
				cacheCreationInputTokens: 20000,
				costUSD: 0.52,
			},
		},
	};
	writeFileSync(
		path.join(claudeDir, "stats-cache.json"),
		JSON.stringify(statsCache, null, "	"),
		"utf8",
	);

	const claudeStandardEvents = [
		{
			type: "user",
			sessionId: "claude-sess-1",
			uuid: "u1",
			timestamp: "2026-03-15T10:00:00.000Z",
			cwd: "/path/to/project",
			message: {
				role: "user",
				content: [{ type: "text", text: "Implement the login endpoint" }],
			},
		},
		{
			type: "assistant",
			sessionId: "claude-sess-1",
			parentUuid: "u1",
			message: {
				id: "msg-1",
				role: "assistant",
				model: "claude-3-7-sonnet",
				content: [
					{
						type: "thinking",
						thinking: "I should check auth config and write the endpoint.",
					},
					{ type: "text", text: "I will create auth.ts." },
					{
						type: "tool_use",
						id: "t1",
						name: "write_file",
						input: { path: "auth.ts" },
					},
				],
				usage: {
					input_tokens: 1500,
					output_tokens: 450,
					cache_read_input_tokens: 8000,
					cache_creation_input_tokens: 1200,
				},
			},
		},
	];
	writeJsonlFile(
		path.join(
			claudeDir,
			"projects",
			"sample-project",
			"ceda31df-a9d4-4ab8-9409-3f3ac444b272.jsonl",
		),
		claudeStandardEvents,
	);
	writeFileSync(path.join(claudeDir, "boundary-empty.jsonl"), "", "utf8");
	writeFileSync(
		path.join(claudeDir, "boundary-corrupted.jsonl"),
		toJsonlWithCorruption(claudeStandardEvents),
		"utf8",
	);

	// ==========================================
	// 2. Cline
	// ==========================================
	const clineDir = path.join(HARNESSES_DIR, "cline");
	const clineTaskDir = path.join(clineDir, "tasks", "task-cline-101");
	const clineZeroDir = path.join(clineDir, "tasks", "boundary-zero-tokens");
	mkdirSync(clineTaskDir, { recursive: true });
	mkdirSync(clineZeroDir, { recursive: true });

	const clineHistory = [
		{
			id: "task-cline-101",
			ulid: "01JCLINE101EXAMPLE00000001",
			ts: 1773500000000,
			task: "Refactor token counter",
			tokensIn: 45000,
			tokensOut: 3200,
			cacheWrites: 1200,
			cacheReads: 18000,
			totalCost: 0.15,
			cwdOnTaskInitialization: "/workspace/project-alpha",
			modelId: "claude-3-5-sonnet-20241022",
		},
	];
	writeFileSync(
		path.join(clineDir, "taskHistory.json"),
		JSON.stringify(clineHistory, null, "	"),
		"utf8",
	);

	const clineMessages = [
		{
			ts: 1773500001000,
			type: "say",
			say: "user_feedback",
			text: "Refactor token counter",
		},
		{
			ts: 1773500005000,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: "...",
				tokensIn: 12500,
				tokensOut: 850,
				cacheWrites: 500,
				cacheReads: 6000,
				cost: 0.042,
			}),
			modelInfo: {
				providerId: "anthropic",
				modelId: "claude-3-5-sonnet-20241022",
			},
		},
		{
			ts: 1773500010000,
			type: "say",
			say: "text",
			text: "Refactoring completed successfully.",
		},
	];
	writeFileSync(
		path.join(clineTaskDir, "ui_messages.json"),
		JSON.stringify(clineMessages, null, "	"),
		"utf8",
	);
	writeFileSync(
		path.join(clineTaskDir, "task_metadata.json"),
		JSON.stringify(
			{
				id: "task-cline-101",
				task: "Refactor token counter",
				createdAt: 1773500000000,
				model: "claude-3-5-sonnet-20241022",
			},
			null,
			"\t",
		),
		"utf8",
	);
	writeFileSync(
		path.join(clineTaskDir, "api_conversation_history.json"),
		JSON.stringify(
			[
				{ role: "user", content: "Refactor token counter" },
				{ role: "assistant", content: "Refactoring completed successfully." },
			],
			null,
			"\t",
		),
		"utf8",
	);

	const clineZeroMessages = [
		{
			ts: 1773500001000,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: "...",
				tokensIn: 0,
				tokensOut: 0,
				cacheWrites: 0,
				cacheReads: 0,
				cost: 0,
			}),
			modelInfo: {
				providerId: "anthropic",
				modelId: "claude-3-5-sonnet-20241022",
			},
		},
	];
	writeFileSync(
		path.join(clineZeroDir, "ui_messages.json"),
		JSON.stringify(clineZeroMessages, null, "	"),
		"utf8",
	);

	// ==========================================
	// 3. Roo Code
	// ==========================================
	const rooDir = path.join(HARNESSES_DIR, "roo");
	const rooTaskDir = path.join(rooDir, "tasks", "task-roo-101");
	mkdirSync(rooTaskDir, { recursive: true });

	const rooHistory = [
		{
			id: "task-roo-101",
			ulid: "01JROO101EXAMPLE0000000001",
			ts: 1773500000000,
			task: "Design system architecture",
			tokensIn: 50000,
			tokensOut: 4500,
			cacheWrites: 2000,
			cacheReads: 25000,
			totalCost: 0.22,
			cwdOnTaskInitialization: "/workspace/project-beta",
			modelId: "claude-3-7-sonnet",
			mode: "architect",
		},
		{
			id: "task-roo-102",
			ulid: "01JROO102EXAMPLE0000000002",
			ts: 1773510000000,
			task: "Implement code modules",
			tokensIn: 32000,
			tokensOut: 2800,
			cacheWrites: 1000,
			cacheReads: 15000,
			totalCost: 0.12,
			cwdOnTaskInitialization: "/workspace/project-beta",
			modelId: "claude-3-5-sonnet",
			mode: "code",
		},
	];
	writeFileSync(
		path.join(rooDir, "taskHistory.json"),
		JSON.stringify(rooHistory, null, "	"),
		"utf8",
	);

	const rooMessages = [
		{
			ts: 1773500001000,
			type: "say",
			say: "user_feedback",
			text: "Design system architecture",
			mode: "architect",
		},
		{
			ts: 1773500005000,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				request: "...",
				tokensIn: 18000,
				tokensOut: 1200,
				cacheWrites: 1000,
				cacheReads: 8000,
				cost: 0.065,
			}),
			modelInfo: { providerId: "anthropic", modelId: "claude-3-7-sonnet" },
			mode: "architect",
		},
	];
	writeFileSync(
		path.join(rooTaskDir, "ui_messages.json"),
		JSON.stringify(rooMessages, null, "	"),
		"utf8",
	);
	writeFileSync(
		path.join(rooTaskDir, "task_metadata.json"),
		JSON.stringify(
			{
				id: "task-roo-101",
				task: "Design system architecture",
				mode: "architect",
				createdAt: 1773500000000,
			},
			null,
			"\t",
		),
		"utf8",
	);

	// ==========================================
	// 4. Continue
	// ==========================================
	const continueDir = path.join(HARNESSES_DIR, "continue");
	const continueSessionsDir = path.join(continueDir, "sessions");
	const continueDevDataDir = path.join(continueDir, "dev_data");
	mkdirSync(continueSessionsDir, { recursive: true });
	mkdirSync(continueDevDataDir, { recursive: true });

	const continueSessionCatalog = [
		{
			sessionId: "cont-sess-01",
			title: "Add caching support",
			dateCreated: "1773500000000",
			workspaceDirectory: "file:///workspace/project-alpha",
			messageCount: 2,
		},
	];
	writeFileSync(
		path.join(continueSessionsDir, "sessions.json"),
		JSON.stringify(continueSessionCatalog, null, "	"),
		"utf8",
	);

	const continueSessionDetail = {
		sessionId: "cont-sess-01",
		title: "Add caching support",
		workspaceDirectory: "file:///workspace/project-alpha",
		history: [
			{
				message: { role: "user", content: "Add caching support" },
				contextItems: [],
			},
			{
				message: {
					role: "assistant",
					content: "Here is the caching layer implementation.",
				},
				contextItems: [],
			},
		],
	};
	writeFileSync(
		path.join(continueSessionsDir, "cont-sess-01.json"),
		JSON.stringify(continueSessionDetail, null, "	"),
		"utf8",
	);

	const continueTokensGen = [
		{
			timestamp: "2026-03-15T10:00:00.000Z",
			eventName: "tokensGenerated",
			model: "gpt-4o",
			provider: "openai",
			promptTokens: 2500,
			generatedTokens: 600,
		},
		{
			timestamp: "2026-03-15T10:05:00.000Z",
			eventName: "tokensGenerated",
			model: "gpt-4o",
			provider: "openai",
			promptTokens: 3100,
			generatedTokens: 820,
		},
	];
	writeJsonlFile(
		path.join(continueDevDataDir, "tokensGenerated.jsonl"),
		continueTokensGen,
	);

	const continueChatInteractions = [
		{
			timestamp: "2026-03-15T10:00:00.000Z",
			eventName: "chatInteraction",
			prompt: "Add caching support",
			completion: "Here is the cache module...",
			modelName: "gpt-4o",
			modelProvider: "openai",
			sessionId: "cont-sess-01",
			tools: ["read_file", "write_file"],
		},
	];
	writeJsonlFile(
		path.join(continueDevDataDir, "chatInteraction.jsonl"),
		continueChatInteractions,
	);

	const continueDb = seedContinueDb(
		path.join(continueDevDataDir, "devdata.sqlite"),
		{
			records: [
				{
					model: "gpt-4o",
					provider: "openai",
					tokensGenerated: 600,
					tokensPrompt: 2500,
					timestamp: "2026-03-15T10:00:00.000Z",
				},
				{
					model: "gpt-4o",
					provider: "openai",
					tokensGenerated: 820,
					tokensPrompt: 3100,
					timestamp: "2026-03-15T10:05:00.000Z",
				},
			],
		},
	);
	closeDatabase(continueDb);

	// ==========================================
	// 5. Cursor
	// ==========================================
	const cursorDir = path.join(HARNESSES_DIR, "cursor");
	const cursorGlobalDir = path.join(cursorDir, "globalStorage");
	const cursorWsDir = path.join(
		cursorDir,
		"workspaceStorage",
		"2ee3deeb64ace8c807fd30c35b249ed0",
	);
	mkdirSync(cursorGlobalDir, { recursive: true });
	mkdirSync(cursorWsDir, { recursive: true });

	const cursorGlobalDb = seedCursorDb(
		path.join(cursorGlobalDir, "state.vscdb"),
		{
			composers: [
				{
					composerId: "cursor-comp-1",
					createdAt: 1773500000000,
					unifiedMode: "agent",
					modelName: "claude-3-5-sonnet",
					text: "Create API routes",
					conversationMap: {
						"bubble-1": { type: "user", text: "Create API routes" },
						"bubble-2": {
							type: "ai",
							text: "Creating routes...",
							tokenUsage: { inputTokens: 3200, outputTokens: 450 },
						},
					},
				},
			],
		},
	);
	closeDatabase(cursorGlobalDb);

	writeFileSync(
		path.join(cursorWsDir, "workspace.json"),
		JSON.stringify(
			{ folder: "file:///workspace/personal-website-v3" },
			null,
			"\t",
		),
		"utf8",
	);

	const cursorWsDb = seedCursorDb(path.join(cursorWsDir, "state.vscdb"), {
		composers: [
			{
				composerId: "cursor-comp-1",
				createdAt: 1773500000000,
				unifiedMode: "agent",
			},
		],
	});
	closeDatabase(cursorWsDb);

	const cursorChatDir = path.join(cursorWsDir, "chatSessions");
	mkdirSync(cursorChatDir, { recursive: true });
	writeFileSync(
		path.join(cursorChatDir, "cursor-chat-1.json"),
		JSON.stringify(
			{
				id: "cursor-chat-1",
				title: "Cursor workspace session",
				requests: [{ message: "Fix layout", response: "Fixed layout" }],
			},
			null,
			"\t",
		),
		"utf8",
	);

	// ==========================================
	// 6. GitHub Copilot
	// ==========================================
	const copilotDir = path.join(HARNESSES_DIR, "copilot");
	const copilotChatDir = path.join(copilotDir, "chatSessions");
	const copilotLogsDir = path.join(copilotDir, "logs");
	mkdirSync(copilotChatDir, { recursive: true });
	mkdirSync(copilotLogsDir, { recursive: true });

	const copilotSession = {
		version: 3,
		sessionId: "copilot-sess-1",
		creationDate: 1773500000000,
		lastMessageDate: 1773500100000,
		responderUsername: "GitHub Copilot",
		requests: [
			{
				timestamp: 1773500005000,
				modelId: "copilot/gpt-4o",
				message: { text: "Write a binary search function" },
				response: [
					{
						value:
							"```typescript\nfunction binarySearch(arr: number[], target: number) {...}\n```",
					},
				],
			},
		],
	};
	writeFileSync(
		path.join(copilotChatDir, "copilot-sess-1.json"),
		JSON.stringify(copilotSession, null, "	"),
		"utf8",
	);
	writeFileSync(
		path.join(copilotLogsDir, "process-test.log"),
		"[INFO] Copilot agent started successfully\n[INFO] Request completed\n",
		"utf8",
	);

	// ==========================================
	// 7. Aider
	// ==========================================
	const aiderDir = path.join(HARNESSES_DIR, "aider");
	mkdirSync(aiderDir, { recursive: true });

	const aiderMarkdown = `# aider chat started at 2026-03-15 10:00:00

#### Write a binary search function

> /test
> PASS

Here is the implementation of binary search.
`;
	writeFileSync(
		path.join(aiderDir, ".aider.chat.history.md"),
		aiderMarkdown,
		"utf8",
	);

	const aiderAnalytics = [
		{
			timestamp: "2026-03-15T10:00:10.000Z",
			session_id: "2026-03-15-10-00-00",
			main_model: "gpt-4o",
			tokens_in: 1400,
			tokens_out: 320,
			cost: 0.0082,
			total_cost: 0.0082,
		},
	];
	writeJsonlFile(path.join(aiderDir, "analytics.jsonl"), aiderAnalytics);

	// ==========================================
	// 8. Windsurf
	// ==========================================
	const windsurfDir = path.join(HARNESSES_DIR, "windsurf");
	const windsurfChatDir = path.join(windsurfDir, "chat_state");
	const windsurfPlansDir = path.join(windsurfDir, "cascade", "plans");
	mkdirSync(windsurfChatDir, { recursive: true });
	mkdirSync(windsurfPlansDir, { recursive: true });

	const windsurfBlob = buildWindsurfChatStateBlob({
		conversationId: "windsurf-sess-1",
		model: "claude-3-5-sonnet",
		prompt: "Implement cascade plan for telemetry",
		completion: "Plan implemented with full wire compatibility.",
		inputTokens: 2800,
		outputTokens: 520,
		timestamp: 1773500000,
	});
	writeFileSync(
		path.join(
			windsurfChatDir,
			"codeium_chat_state_file_workspace_windsurf_project.pb",
		),
		windsurfBlob,
	);
	writeFileSync(
		path.join(windsurfPlansDir, "plan-1.md"),
		"# Cascade Plan 1\n\n- [x] Step 1\n- [ ] Step 2\n",
		"utf8",
	);

	// ==========================================
	// 9. Goose
	// ==========================================
	const gooseDir = path.join(HARNESSES_DIR, "goose");
	const gooseLegacyDir = path.join(gooseDir, "legacy-sessions");
	mkdirSync(gooseLegacyDir, { recursive: true });

	const gooseDb = seedGooseDb(path.join(gooseDir, "sessions.db"), {
		sessions: [
			{
				id: "goose-sess-1",
				description: "Build CLI tool",
				workingDir: "/workspace/goose-project",
				createdAt: 1773500000000,
				updatedAt: 1773500060000,
				messages: [
					{
						role: "user",
						content: "Build CLI tool",
						accumulatedInputTokens: 0,
						accumulatedOutputTokens: 0,
						modelConfig: { model: "claude-3-5-sonnet", provider: "anthropic" },
						createdAt: 1773500000000,
					},
					{
						role: "assistant",
						content: "CLI tool scaffolding created.",
						accumulatedInputTokens: 1800,
						accumulatedOutputTokens: 420,
						modelConfig: { model: "claude-3-5-sonnet", provider: "anthropic" },
						createdAt: 1773500060000,
					},
				],
			},
		],
	});
	closeDatabase(gooseDb);

	const gooseLegacy = [
		{
			type: "session",
			id: "goose-legacy-1",
			working_dir: "/workspace/goose-legacy",
		},
	];
	writeJsonlFile(
		path.join(gooseLegacyDir, "legacy-session.jsonl"),
		gooseLegacy,
	);

	// ==========================================
	// 10. OpenHands
	// ==========================================
	const openhandsDir = path.join(HARNESSES_DIR, "openhands");
	const openhandsConvDir = path.join(
		openhandsDir,
		"conversations",
		"conv-12345",
	);
	const openhandsEventsDir = path.join(openhandsConvDir, "events");
	mkdirSync(openhandsEventsDir, { recursive: true });

	const openhandsBaseState = {
		conversation_id: "conv-12345",
		workspace_path: "/workspace/openhands-project",
		agent_name: "CodeActAgent",
		model_name: "claude-3-5-sonnet-20241022",
		status: "STOPPED",
		metrics: {
			accumulated_cost: 0.052,
			total_tokens: 16000,
			prompt_tokens: 13000,
			completion_tokens: 3000,
		},
		created_at: "2026-03-15T10:00:00Z",
		updated_at: "2026-03-15T10:15:00Z",
	};
	writeFileSync(
		path.join(openhandsConvDir, "base_state.json"),
		JSON.stringify(openhandsBaseState, null, "	"),
		"utf8",
	);

	writeFileSync(
		path.join(openhandsEventsDir, "event-0.json"),
		JSON.stringify(
			{
				id: 0,
				timestamp: "2026-03-15T10:00:05Z",
				source: "user",
				message: "Fix broken pipeline",
			},
			null,
			"\t",
		),
		"utf8",
	);
	writeFileSync(
		path.join(openhandsEventsDir, "event-1.json"),
		JSON.stringify(
			{
				id: 1,
				timestamp: "2026-03-15T10:00:20Z",
				source: "agent",
				action: "run",
				thought: "Checking CI config",
				args: { command: "cat .github/workflows/ci.yml" },
				metrics: {
					prompt_tokens: 1400,
					completion_tokens: 110,
					cost: 0.0045,
				},
			},
			null,
			"\t",
		),
		"utf8",
	);

	// ==========================================
	// 11. Codex CLI
	// ==========================================
	const codexDir = path.join(HARNESSES_DIR, "codex");
	const codexSessionsDir = path.join(codexDir, "sessions", "2026", "03", "15");
	mkdirSync(codexSessionsDir, { recursive: true });

	const codexEvents = [
		{
			type: "session_meta",
			payload: {
				id: "codex-sess-1",
				cwd: "/workspace/codex-project",
				timestamp: "2026-03-15T10:00:00.000Z",
			},
		},
		{
			type: "turn_context",
			payload: { model: "gpt-5", cwd: "/workspace/codex-project" },
		},
		{
			type: "response_item",
			payload: { type: "message", role: "user", content: "Run unit tests" },
		},
		{
			type: "token_usage_record",
			payload: {
				usage: {
					input_tokens: 2000,
					output_tokens: 400,
					cached_input_tokens: 1200,
					reasoning_output_tokens: 60,
				},
			},
		},
	];
	writeJsonlFile(
		path.join(codexSessionsDir, "rollout-thread-1.jsonl"),
		codexEvents,
	);
	writeZstdJsonlFile(
		path.join(codexSessionsDir, "rollout-thread-compressed.jsonl.zst"),
		codexEvents,
	);

	// ==========================================
	// 12. DSH (DeepSeek Harness)
	// ==========================================
	const dshDir = path.join(HARNESSES_DIR, "dsh");
	const dshSessionDir = path.join(
		dshDir,
		"sessions",
		"--workspace-dsh-project--",
		"session-dsh-1",
	);
	mkdirSync(dshSessionDir, { recursive: true });

	const dshEvents = [
		{
			type: "session",
			id: "dsh-sess-1",
			cwd: "/workspace/dsh-project",
			createdAt: "2026-03-15T10:00:00.000Z",
		},
		{
			type: "user/message",
			data: { content: "Generate migration script" },
		},
		{
			type: "assistant/message",
			id: "dsh-msg-1",
			time: "2026-03-15T10:00:15.000Z",
			data: {
				message: { source: { provider: "deepseek", model: "deepseek-coder" } },
				usage: {
					inputTokens: 1800,
					outputTokens: 500,
					cacheReadTokens: 1000,
					reasoningTokens: 50,
				},
			},
		},
	];
	writeJsonlFile(path.join(dshSessionDir, "session.jsonl"), dshEvents);
	writeZstdJsonlFile(
		path.join(dshSessionDir, "session.v3.jsonl.zstd"),
		dshEvents,
	);

	// ==========================================
	// 13. OpenCode
	// ==========================================
	const opencodeDir = path.join(HARNESSES_DIR, "opencode");
	mkdirSync(opencodeDir, { recursive: true });

	const opencodeV2Db = seedOpenCodeDb(
		path.join(opencodeDir, "opencode-v2.db"),
		{
			version: "v2",
			sessions: [
				{
					id: "oc-sess-1",
					directory: "/workspace/opencode-project",
					model: "claude-3-5-sonnet",
					messages: [
						{
							id: "msg-u1",
							type: "user",
							data: { role: "user", text: "Build frontend" },
							time: 1773500000000,
						},
						{
							id: "msg-a1",
							type: "assistant",
							data: {
								model: { id: "claude-3-5-sonnet", providerID: "anthropic" },
								tokens: {
									input: 2200,
									output: 600,
									reasoning: 0,
									cache: { read: 1500, write: 200 },
								},
								cost: 0.0095,
								time: { created: 1773500010000 },
							},
							time: 1773500010000,
						},
					],
				},
			],
		},
	);
	closeDatabase(opencodeV2Db);

	const opencodeLegacyDb = seedOpenCodeDb(
		path.join(opencodeDir, "opencode-legacy.db"),
		{
			version: "v1",
			sessions: [
				{
					id: "oc-sess-legacy-1",
					directory: "/workspace/opencode-legacy",
					messages: [
						{
							id: "msg-leg-u1",
							type: "user",
							data: { role: "user", text: "Legacy query" },
							time: 1773500000000,
						},
						{
							id: "msg-leg-a1",
							type: "assistant",
							data: {
								role: "assistant",
								model: { id: "claude-3-5-sonnet", providerID: "anthropic" },
								tokens: { input: 1500, output: 300 },
								cost: 0.005,
							},
							time: 1773500010000,
						},
					],
				},
			],
		},
	);
	closeDatabase(opencodeLegacyDb);

	// ==========================================
	// 14. Command Code
	// ==========================================
	const ccDir = path.join(HARNESSES_DIR, "commandcode");
	const ccProjectDir = path.join(ccDir, "projects", "test-project");
	mkdirSync(ccProjectDir, { recursive: true });

	const ccEvents = [
		{
			type: "session",
			id: "cc-sess-1",
			cwd: "/workspace/commandcode-project",
			timestamp: "2026-03-15T10:00:00.000Z",
		},
		{
			type: "message",
			message: { role: "user" },
			timestamp: "2026-03-15T10:00:01.000Z",
		},
		{
			type: "message",
			id: "cc-msg-1",
			role: "assistant",
			model: "claude-3-7-sonnet",
			timestamp: "2026-03-15T10:00:10.000Z",
			usage: {
				inputTokens: 1600,
				outputTokens: 380,
				cacheReadTokens: 900,
				cacheWriteTokens: 150,
				reasoningTokens: 40,
				costUsd: 0.0075,
			},
		},
	];
	writeJsonlFile(path.join(ccProjectDir, "commandcode-1.jsonl"), ccEvents);
	writeJsonlFile(path.join(ccDir, "history.jsonl"), [
		{
			timestamp: 1773500000000,
			command: "run unit test",
			project: "test-project",
		},
	]);

	// ==========================================
	// 15. Antigravity
	// ==========================================
	const agDir = path.join(HARNESSES_DIR, "antigravity");
	const agConvDir = path.join(agDir, "conversations");
	mkdirSync(agConvDir, { recursive: true });

	const agTrajBlob = buildAntigravityTrajectoryMetadata({
		conversationId: "ag-sess-1",
		cwd: "/workspace/antigravity-project",
		workerName: "Swarm Worker",
	});
	const agTimestamp = buildAntigravityTimestampMeta(1773500000);
	const agUserPayload = buildAntigravityStepPayload({
		userRequest: "Fix typecheck error",
		instructionWrapper: true,
	});
	const agGenMeta = buildAntigravityGenMetadata({
		model: "gemini-2.5-pro",
		inputTokens: 2500,
		outputTokens: 450,
		cacheReadTokens: 1800,
		reasoningTokens: 50,
		requestId: "req-ag-1",
	});

	const agConvDb = seedAntigravityDb(path.join(agConvDir, "ag-sess-1.db"), {
		trajectoryBlob: agTrajBlob,
		steps: [
			{
				idx: 0,
				stepType: 14,
				status: 1,
				metadata: agTimestamp,
				payload: agUserPayload,
			},
			{
				idx: 1,
				stepType: 15,
				status: 1,
				metadata: agTimestamp,
				payload: new Uint8Array(),
			},
		],
		genMetadata: [{ idx: 1, data: agGenMeta }],
	});
	closeDatabase(agConvDb);

	const agSummariesDb = seedAntigravitySummariesDb(
		path.join(agDir, "conversation_summaries.db"),
		{
			summaries: [
				{
					conversationId: "ag-sess-1",
					title: "Fix typecheck error",
					workspaceUris: ["file:///workspace/antigravity-project"],
					lastModifiedTime: "2026-03-15T10:00:00Z",
				},
			],
		},
	);
	closeDatabase(agSummariesDb);

	// ==========================================
	// CROSS-PLATFORM DIRECTORY MOCKS
	// ==========================================
	console.log("Generating cross-platform simulated environments...");

	// A. macOS (darwin)
	const darwinDir = path.join(PLATFORMS_DIR, "darwin");
	const darwinAppSupport = path.join(
		darwinDir,
		"Library",
		"Application Support",
	);
	const darwinCache = path.join(
		darwinDir,
		"Library",
		"Caches",
		"harness-token-usage",
	);
	mkdirSync(darwinAppSupport, { recursive: true });
	mkdirSync(darwinCache, { recursive: true });

	// Cursor on macOS
	const darwinCursorDb = seedCursorDb(
		path.join(
			darwinAppSupport,
			"Cursor",
			"User",
			"globalStorage",
			"state.vscdb",
		),
		{
			composers: [
				{
					composerId: "darwin-cursor-comp",
					createdAt: 1773500000000,
					unifiedMode: "agent",
					modelName: "claude-3-5-sonnet",
				},
			],
		},
	);
	closeDatabase(darwinCursorDb);

	// Cline on macOS
	mkdirSync(
		path.join(
			darwinAppSupport,
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
		),
		{ recursive: true },
	);
	writeFileSync(
		path.join(
			darwinAppSupport,
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
			"taskHistory.json",
		),
		JSON.stringify(clineHistory, null, "	"),
		"utf8",
	);

	// Claude on macOS (~/.claude)
	const darwinClaude = path.join(darwinDir, ".claude");
	mkdirSync(path.join(darwinClaude, "projects", "sample-project"), {
		recursive: true,
	});
	writeFileSync(
		path.join(darwinClaude, "stats-cache.json"),
		JSON.stringify(statsCache, null, "	"),
		"utf8",
	);
	writeJsonlFile(
		path.join(
			darwinClaude,
			"projects",
			"sample-project",
			"session-darwin.jsonl",
		),
		claudeStandardEvents,
	);

	// models.dev cache
	writeFileSync(
		path.join(darwinCache, "models.dev.json"),
		JSON.stringify({ "claude-3-7-sonnet": { cost: 0.003 } }, null, "	"),
		"utf8",
	);

	// B. Linux
	const linuxDir = path.join(PLATFORMS_DIR, "linux");
	const linuxConfig = path.join(linuxDir, ".config");
	const linuxData = path.join(linuxDir, ".local", "share");
	const linuxCache = path.join(linuxDir, ".cache", "harness-token-usage");
	mkdirSync(linuxConfig, { recursive: true });
	mkdirSync(linuxData, { recursive: true });
	mkdirSync(linuxCache, { recursive: true });

	// Roo Code on Linux
	mkdirSync(
		path.join(
			linuxConfig,
			"Code",
			"User",
			"globalStorage",
			"rooveterinaryinc.roo-cline",
		),
		{ recursive: true },
	);
	writeFileSync(
		path.join(
			linuxConfig,
			"Code",
			"User",
			"globalStorage",
			"rooveterinaryinc.roo-cline",
			"taskHistory.json",
		),
		JSON.stringify(rooHistory, null, "	"),
		"utf8",
	);

	// OpenCode on Linux ($XDG_DATA_HOME/opencode/opencode.db)
	const linuxOpencodeDb = seedOpenCodeDb(
		path.join(linuxData, "opencode", "opencode.db"),
		{ version: "v2" },
	);
	closeDatabase(linuxOpencodeDb);

	// Goose on Linux ($XDG_DATA_HOME/goose/sessions/sessions.db)
	const linuxGooseDb = seedGooseDb(
		path.join(linuxData, "goose", "sessions", "sessions.db"),
	);
	closeDatabase(linuxGooseDb);

	// Claude on Linux (~/.claude)
	mkdirSync(path.join(linuxDir, ".claude"), { recursive: true });
	writeFileSync(
		path.join(linuxDir, ".claude", "stats-cache.json"),
		JSON.stringify(statsCache, null, "	"),
		"utf8",
	);

	writeFileSync(
		path.join(linuxCache, "models.dev.json"),
		JSON.stringify({ "claude-3-7-sonnet": { cost: 0.003 } }, null, "	"),
		"utf8",
	);

	// C. Windows (win32)
	const win32Dir = path.join(PLATFORMS_DIR, "win32");
	const winRoaming = path.join(win32Dir, "AppData", "Roaming");
	const winLocal = path.join(win32Dir, "AppData", "Local");
	mkdirSync(winRoaming, { recursive: true });
	mkdirSync(winLocal, { recursive: true });

	// Cursor on Windows (%APPDATA%\Cursor\User\globalStorage\state.vscdb)
	const winCursorDb = seedCursorDb(
		path.join(winRoaming, "Cursor", "User", "globalStorage", "state.vscdb"),
		{
			composers: [
				{
					composerId: "win-cursor-comp",
					createdAt: 1773500000000,
					unifiedMode: "agent",
				},
			],
		},
	);
	closeDatabase(winCursorDb);

	// Cline on Windows (%APPDATA%\Code\User\globalStorage\saoudrizwan.claude-dev)
	mkdirSync(
		path.join(
			winRoaming,
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
		),
		{ recursive: true },
	);
	writeFileSync(
		path.join(
			winRoaming,
			"Code",
			"User",
			"globalStorage",
			"saoudrizwan.claude-dev",
			"taskHistory.json",
		),
		JSON.stringify(clineHistory, null, "	"),
		"utf8",
	);

	// Goose on Windows (%APPDATA%\Block\goose\data\sessions\sessions.db)
	const winGooseDb = seedGooseDb(
		path.join(winRoaming, "Block", "goose", "data", "sessions", "sessions.db"),
	);
	closeDatabase(winGooseDb);

	// OpenCode on Windows (%LOCALAPPDATA%\opencode\opencode.db)
	const winOpencodeDb = seedOpenCodeDb(
		path.join(winLocal, "opencode", "opencode.db"),
		{ version: "v2" },
	);
	closeDatabase(winOpencodeDb);

	// Cache on Windows (%LOCALAPPDATA%\harness-token-usage\Cache\models.dev.json)
	const winCache = path.join(winLocal, "harness-token-usage", "Cache");
	mkdirSync(winCache, { recursive: true });
	writeFileSync(
		path.join(winCache, "models.dev.json"),
		JSON.stringify({ "claude-3-7-sonnet": { cost: 0.003 } }, null, "	"),
		"utf8",
	);

	// Userprofile dotfiles on Windows (%USERPROFILE%\.claude, %USERPROFILE%\.continue)
	mkdirSync(
		path.join(win32Dir, ".claude", "projects", "C-Users-testuser-Code-Project"),
		{ recursive: true },
	);
	writeFileSync(
		path.join(win32Dir, ".claude", "stats-cache.json"),
		JSON.stringify(statsCache, null, "	"),
		"utf8",
	);
	writeJsonlFile(
		path.join(
			win32Dir,
			".claude",
			"projects",
			"C-Users-testuser-Code-Project",
			"session-win.jsonl",
		),
		claudeStandardEvents,
	);

	console.log("All fixtures generated successfully.");
}

// When run directly as a CLI script:
if (import.meta.main) {
	generateAllFixtures();
}
