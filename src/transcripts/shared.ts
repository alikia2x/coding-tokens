import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import type { HarnessName, UsageRecord } from "../types";
import { objectOrEmpty, parseJsonl, textOrNull } from "../util";

export type ExportDetail =
	| "user_only"
	| "chat_compact"
	| "chat"
	| "chat_tools"
	| "agent"
	| "agent_full";

export type TranscriptRole =
	| "user"
	| "assistant"
	| "tool"
	| "system"
	| "developer"
	| "other";

export type TranscriptKind = "message" | "tool_call" | "tool_result" | "other";

export type ToolCategory = "command" | "read" | "write" | "other";

export interface TranscriptItem {
	id: string;
	order: number;
	turnId: string;
	role: TranscriptRole;
	kind: TranscriptKind;
	phase: "final" | "intermediate" | "unknown";
	text?: string;
	name?: string;
	input?: unknown;
	output?: unknown;
	toolCallId?: string;
	usageId?: string;
	category?: ToolCategory;
	status?: string;
	timestamp: number | null;
}

export interface TranscriptSession {
	harness: HarnessName;
	sessionId: string;
	cwd: string | null;
	startedAt: number | null;
	title?: string;
	usageRecords?: UsageRecord[];
	items: TranscriptItem[];
}

export interface TranscriptReadResult {
	harness: HarnessName;
	available: boolean;
	sessions: TranscriptSession[];
	warnings: string[];
}

export interface TranscriptFilters {
	harnesses: Set<HarnessName>;
	projects?: Set<string>;
	date?: string;
	/** Inclusive lower bound in epoch milliseconds. */
	since?: number;
	/** Exclusive upper bound in epoch milliseconds. */
	until?: number;
}

export function newSession(
	harness: HarnessName,
	sessionId: string,
	cwd: string | null,
	startedAt: number | null,
	title?: string,
): TranscriptSession {
	return {
		harness,
		sessionId,
		cwd,
		startedAt,
		title,
		items: [],
	};
}

export function addItem(
	session: TranscriptSession,
	item: Omit<TranscriptItem, "order">,
): TranscriptItem {
	const complete = { ...item, order: session.items.length };
	session.items.push(complete);
	return complete;
}

export function addToolCall(
	session: TranscriptSession,
	name: string,
	input: unknown,
	callId: string | null,
	turnId: string,
	timestamp: number | null,
	status?: string,
): TranscriptItem {
	return addItem(session, {
		id: callId ?? `tool-${session.items.length}`,
		turnId,
		role: "tool",
		kind: "tool_call",
		phase: "intermediate",
		name,
		input,
		toolCallId: callId ?? undefined,
		category: categoryForTool(name),
		status,
		timestamp,
	});
}

export function typeOf(value: unknown): string {
	return textOrNull(objectOrEmpty(value).type) ?? "";
}

export function idString(value: unknown): string | null {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	return null;
}

export function contentBlocks(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	return value.map(objectOrEmpty);
}

export function isReasoningType(type: string): boolean {
	const normalized = type.toLowerCase();
	return (
		normalized.includes("reasoning") ||
		normalized.includes("thinking") ||
		normalized === "analysis" ||
		normalized === "encrypted_content"
	);
}

export function textFromContent(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	const lines: string[] = [];
	for (const blockValue of value) {
		const block = objectOrEmpty(blockValue);
		const type = typeOf(block);
		if (isReasoningType(type)) continue;
		if (
			type === "text" ||
			type === "input_text" ||
			type === "output_text" ||
			type === "markdown"
		) {
			if (typeof block.text === "string") lines.push(block.text);
			continue;
		}
		if (type === "tool-result" || type === "tool_result") {
			const nested = textFromContent(block.content ?? block.text);
			if (nested) lines.push(nested);
			continue;
		}
		if (type.includes("image")) {
			const name =
				textOrNull(block.filename) ??
				textOrNull(objectOrEmpty(block.source).filename);
			lines.push(name ? `[Image: ${name}]` : "[Image attached]");
			continue;
		}
		if (type === "file" || type.includes("input_file")) {
			const name =
				textOrNull(block.filename) ??
				textOrNull(block.name) ??
				textOrNull(block.path);
			lines.push(name ? `[File: ${name}]` : "[File attached]");
		}
	}
	return lines.join("\n");
}

interface HarnessMessageRule {
	/** Patterns identifying injected/synthetic user messages to drop completely. */
	injectedPatterns?: readonly RegExp[];
	/** Patterns identifying post-strip metadata-only messages to drop completely. */
	emptyAfterCleanPatterns?: readonly RegExp[];
	/** Custom pre-tag-strip extractor; returning a string short-circuits default stripping. */
	extract?: (value: string) => string | null;
	/** Replace the default tag list entirely instead of extending it. */
	replaceDefaultTags?: readonly string[];
	/** Additional tags to strip alongside DEFAULT_USER_MESSAGE_TAGS. */
	extraTags?: readonly string[];
	/** Optional post-strip transform applied after removeTaggedBlocks. */
	postStrip?: (value: string) => string;
}

const DEFAULT_USER_MESSAGE_TAGS = [
	"system-reminder",
	"environment_context",
	"external_codex_apps_open_page",
	"recommended_plugins",
	"skills_instructions",
	"app-context",
	"Work_Context",
	"session-context",
	"auto-slash-command",
	"command-instruction",
	"user-request",
] as const;

const CODEX_EXTRA_TAGS = [
	"codex_internal_context",
	"guardian_tool_descriptions",
	"subagents",
	"turn_aborted",
	"subagent_notification",
	"codex_delegation",
	"image",
] as const;

const CODEX_REQUEST_TAGS = [
	"system-reminder",
	"environment_context",
	"external_codex_apps_open_page",
	"codex_internal_context",
	"guardian_tool_descriptions",
	"subagents",
	"image",
] as const;

const ANTIGRAVITY_USER_MESSAGE_TAGS = [
	"t3_code_instructions",
	"t3_context",
	"runtime_info",
	"pull_request_linking",
	"system-reminder",
	"environment_context",
	"skills_instructions",
] as const;

const CODEX_METADATA_HEADING_RE =
	/^\s*#{0,6}\s*(?:Files mentioned by the user|Referenced chats with Codex|Response annotations)\b/iu;

function removeTaggedBlocks(value: string, tags: readonly string[]): string {
	let text = value;
	for (const tag of tags) {
		const escaped = tag.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
		text = text
			.replace(
				new RegExp(`<${escaped}\\b[^>]*>[\\s\\S]*?<\\/${escaped}\\s*>`, "giu"),
				"",
			)
			.replace(new RegExp(`<${escaped}\\b[^>]*/\\s*>`, "giu"), "");
	}
	return text
		.replaceAll(/[ \t]+\n/gu, "\n")
		.replaceAll(/\n{3,}/gu, "\n\n")
		.trim();
}

function codexMyRequest(value: string): string | null {
	const marker = /(?:^|\n)#{0,6}\s*My request(?: for Codex)?\s*:\s*/iu.exec(
		value,
	);
	if (!marker) return null;
	return value.slice(marker.index + marker[0].length).trim();
}

function codexAnnotationText(value: string): string | null {
	const block =
		/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/iu.exec(
			value,
		);
	if (!block?.[1]) return null;
	try {
		const parsed: unknown = JSON.parse(block[1]);
		if (!Array.isArray(parsed)) return null;
		const lines = parsed
			.map((entry) => {
				const record = objectOrEmpty(entry);
				const selected = textOrNull(record.text)?.trim() ?? "";
				const comment = textOrNull(record.annotation)?.trim() ?? "";
				if (selected && comment) return `> ${selected}\n\n${comment}`;
				if (comment) return comment;
				if (selected) return `> ${selected}`;
				return "";
			})
			.filter(Boolean);
		return lines.length ? lines.join("\n\n") : null;
	} catch {
		return null;
	}
}

function extractCodexUserMessage(value: string): string | null {
	const questionReply = value.match(
		/<send_user_message_question_reply\b[^>]*>([\s\S]*?)<\/send_user_message_question_reply\s*>/iu,
	)?.[1];
	if (questionReply !== undefined) {
		try {
			const parsed: unknown = JSON.parse(questionReply);
			if (Array.isArray(parsed)) {
				const answers = parsed
					.map((entry) => textOrNull(objectOrEmpty(entry).answer))
					.filter((answer): answer is string => answer !== null);
				if (answers.length) return answers.join("\n");
			}
		} catch {
			// Keep the remaining message when the UI wrapper is malformed.
		}
	}

	const annotations = codexAnnotationText(value);
	const request = codexMyRequest(value);
	if (annotations !== null || request !== null) {
		const body = [annotations, request].filter(Boolean).join("\n\n");
		return body ? removeTaggedBlocks(body, CODEX_REQUEST_TAGS) : "";
	}

	if (CODEX_METADATA_HEADING_RE.test(value)) return "";
	return null;
}

function extractOpenCodeUserMessage(value: string): string | null {
	const requests = [
		...value.matchAll(/<user-request\b[^>]*>([\s\S]*?)<\/user-request>/giu),
	]
		.map((match) => match[1]?.trim() ?? "")
		.filter(Boolean);
	if (!value.includes("<auto-slash-command") && requests.length === 0) {
		return null;
	}
	if (requests.length > 0) {
		return removeTaggedBlocks(requests.at(-1) ?? "", ["session-context"]);
	}
	const fallback = value.match(
		/(?:^|\n)---\s*\n## User Request\s*\n([\s\S]*?)(?:\n---|$)/iu,
	)?.[1];
	return fallback ? removeTaggedBlocks(fallback, ["session-context"]) : "";
}

const HARNESS_MESSAGE_RULES: Partial<Record<HarnessName, HarnessMessageRule>> =
	{
		codex: {
			injectedPatterns: [
				/^\s*(?:#\s*AGENTS\.md instructions\b|The following is the Codex agent history|<codex_internal_context|<turn_aborted|<subagent_notification|<codex_delegation)\b/iu,
			],
			emptyAfterCleanPatterns: [CODEX_METADATA_HEADING_RE],
			extract: extractCodexUserMessage,
			extraTags: CODEX_EXTRA_TAGS,
		},
		opencode: {
			extract: extractOpenCodeUserMessage,
		},
		antigravity: {
			replaceDefaultTags: ANTIGRAVITY_USER_MESSAGE_TAGS,
			postStrip: (text) =>
				text.replace(/<\/?user_request\b[^>]*>/giu, "").trim(),
		},
		dsh: {
			injectedPatterns: [
				/^\s*Current runtime context\. This snapshot supersedes earlier runtime-context snapshots\./iu,
			],
		},
	};

export function isInjectedUserMessage(
	harness: HarnessName,
	value: string,
): boolean {
	const patterns = HARNESS_MESSAGE_RULES[harness]?.injectedPatterns;
	return patterns ? patterns.some((pattern) => pattern.test(value)) : false;
}

export function cleanUserMessage(harness: HarnessName, value: string): string {
	if (isInjectedUserMessage(harness, value)) return "";
	const rule = HARNESS_MESSAGE_RULES[harness];
	const extracted = rule?.extract?.(value);
	if (extracted !== null && extracted !== undefined) return extracted;

	const tags = rule?.replaceDefaultTags
		? rule.replaceDefaultTags
		: rule?.extraTags
			? [...DEFAULT_USER_MESSAGE_TAGS, ...rule.extraTags]
			: DEFAULT_USER_MESSAGE_TAGS;
	const stripped = removeTaggedBlocks(value, tags);
	const cleaned = rule?.postStrip ? rule.postStrip(stripped) : stripped;

	if (isInjectedUserMessage(harness, cleaned)) return "";
	if (rule?.emptyAfterCleanPatterns?.some((pattern) => pattern.test(cleaned))) {
		return "";
	}
	return cleaned;
}

export function categoryForTool(name: string): ToolCategory {
	const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "_");
	if (
		/(^|_)(bash|shell|command|exec|exec_command|shell_command|run_command|command_status|send_command_input|terminal)(_|$)/u.test(
			normalized,
		)
	) {
		return "command";
	}
	if (
		/(^|_)(read|view|grep|glob|search|find|list|ls|cat|read_file|view_file|view_file_outline|view_code_item|grep_search|find_by_name|list_dir|list_directory|find_file|read_url_content|search_web|read_resource|list_resources|webfetch|websearch|web_search|web_fetch|read_directory|read_image|codesearch)(_|$)/u.test(
			normalized,
		)
	) {
		return "read";
	}
	if (
		/(^|_)(write|edit|patch|apply_patch|replace|replace_file_content|multi_replace_file_content|write_to_file|write_file|edit_file|save|delete|remove|move|rename|mkdir|create_file|create_dir)(_|$)/u.test(
			normalized,
		)
	) {
		return "write";
	}
	return "other";
}

export function readJsonlFile(filePath: string): unknown[] {
	const bytes = readFileSync(filePath);
	const text = /\.zstd?$/u.test(filePath)
		? zstdDecompressSync(bytes).toString("utf8")
		: bytes.toString("utf8");
	return parseJsonl(text);
}

export function inferFinalMessages(session: TranscriptSession): void {
	const turns = new Set(session.items.map((item) => item.turnId));
	for (const turnId of turns) {
		inferUnknownFinalMessage(session, turnId);
	}
}

export function inferUnknownFinalMessage(
	session: TranscriptSession,
	turnId: string,
): void {
	const hasFinal = session.items.some(
		(item) =>
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.phase === "final",
	);
	if (hasFinal) return;
	let lastToolOrder = -1;
	for (const item of session.items) {
		if (item.turnId === turnId && item.kind === "tool_call")
			lastToolOrder = Math.max(lastToolOrder, item.order);
	}
	let final: TranscriptItem | undefined;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.phase === "unknown" &&
			item.order > lastToolOrder
		)
			final = item;
	}
	if (!final) return;
	for (const item of session.items) {
		if (
			item.turnId === turnId &&
			item.role === "assistant" &&
			item.kind === "message" &&
			item.phase === "unknown"
		)
			item.phase = item === final ? "final" : "intermediate";
	}
}

export function inferUnknownFinalMessages(sessions: TranscriptSession[]): void {
	for (const session of sessions) inferFinalMessages(session);
}

function hasNonEmptySidecar(filePath: string): boolean {
	try {
		return statSync(filePath).size > 0;
	} catch {
		return false;
	}
}

export function openReadonlyDatabase(dbPath: string): Database {
	const hasPendingSidecar =
		hasNonEmptySidecar(`${dbPath}-wal`) ||
		hasNonEmptySidecar(`${dbPath}-journal`);
	if (hasPendingSidecar)
		return new Database(dbPath, { readonly: true, create: false });
	return new Database(`${pathToFileURL(dbPath).href}?immutable=1`, {
		readonly: true,
		create: false,
	});
}

export function tablesIn(db: Database): Set<string> {
	return new Set(
		db
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			)
			.all()
			.map((row) => row.name),
	);
}

export function shaSegment(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 10);
}
