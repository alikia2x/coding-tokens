import type { ToolOperation, ToolVerb } from "../../shared/types";
import type { ToolCategory } from "../transcripts/shared";
import { objectOrEmpty, textOrNull } from "../util";

export interface ToolCallLike {
	name?: string | null;
	input?: unknown;
	category?: ToolCategory | null;
	status?: string | null;
}

export interface ToolResultLike {
	output?: unknown;
	text?: string | null;
	status?: string | null;
}

export interface PairedTool<T> {
	call: T;
	results: T[];
}

export function pairToolItems<
	T extends { kind: string; turnId: string; toolCallId?: string | null },
>(items: readonly T[]): Array<PairedTool<T>> {
	const pairs: Array<PairedTool<T>> = [];
	const byCallId = new Map<string, PairedTool<T>[]>();

	for (const item of items) {
		if (item.kind === "tool_call") {
			const pair: PairedTool<T> = { call: item, results: [] };
			pairs.push(pair);
			if (item.toolCallId) {
				const list = byCallId.get(item.toolCallId) ?? [];
				list.push(pair);
				byCallId.set(item.toolCallId, list);
			}
			continue;
		}
		if (item.kind !== "tool_result") continue;

		// Pass 1: exact callId match (FIFO for repeated IDs, or attach multi-chunk output to latest matching ID).
		if (item.toolCallId) {
			const candidates = byCallId.get(item.toolCallId);
			if (candidates?.length) {
				const openMatch = candidates.find((pair) => pair.results.length === 0);
				const target = openMatch ?? candidates.at(-1);
				target?.results.push(item);
				continue;
			}
		}

		// Pass 2: ID-less result -> earliest open ID-less call in same turn.
		const sameTurnIdless = pairs.find(
			(pair) =>
				pair.results.length === 0 &&
				pair.call.turnId === item.turnId &&
				!pair.call.toolCallId,
		);
		if (sameTurnIdless) {
			sameTurnIdless.results.push(item);
			continue;
		}

		// Pass 3: earliest open call in same turn.
		const sameTurnOpen = pairs.find(
			(pair) => pair.results.length === 0 && pair.call.turnId === item.turnId,
		);
		if (sameTurnOpen) {
			sameTurnOpen.results.push(item);
			continue;
		}

		// Pass 4: LIFO open call across earlier turns, or orphan result.
		const anyOpen = [...pairs]
			.reverse()
			.find((pair) => pair.results.length === 0);
		if (anyOpen) {
			anyOpen.results.push(item);
		} else {
			pairs.push({ call: item, results: [item] });
		}
	}

	return pairs;
}

export function shortenDisplayPath(value: string): string {
	return value
		.replace(/^file:\/\//u, "")
		.replace(/^\/Users\/[^/]+\//u, "~/")
		.replace(/^\/home\/[^/]+\//u, "~/");
}

export function singleLinePreview(value: string, max = 140): string {
	const line =
		value
			.split(/\r?\n/u)
			.map((part) => part.trim())
			.find(Boolean) ?? "";
	if (line.length <= max) return line;
	return `${line.slice(0, max - 1)}…`;
}

function parseInput(input: unknown): {
	obj: Record<string, unknown> | null;
	rawText: string | null;
} {
	if (input === null || input === undefined) {
		return { obj: null, rawText: null };
	}
	if (typeof input === "string") {
		const trimmed = input.trim();
		if (trimmed.startsWith("{")) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return { obj: parsed as Record<string, unknown>, rawText: input };
				}
			} catch {}
		}
		return { obj: null, rawText: input };
	}
	if (typeof input === "object" && !Array.isArray(input)) {
		return {
			obj: input as Record<string, unknown>,
			rawText: JSON.stringify(input, null, 2),
		};
	}
	return { obj: null, rawText: String(input) };
}

function parseOutputObject(output: unknown): Record<string, unknown> | null {
	if (output && typeof output === "object" && !Array.isArray(output)) {
		return output as Record<string, unknown>;
	}
	if (typeof output === "string") {
		const trimmed = output.trim();
		if (trimmed.startsWith("{")) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					return parsed as Record<string, unknown>;
				}
			} catch {}
		}
	}
	return null;
}

export function unwrapToolOutput(
	output: unknown,
	fallbackText?: string | null,
): string | null {
	if (output === null || output === undefined) {
		return fallbackText?.trim() ? fallbackText : null;
	}
	const obj = parseOutputObject(output);
	if (obj) {
		const inner = textOrNull(obj.output) ?? textOrNull(obj.result);
		if (inner !== null) {
			const meta = objectOrEmpty(obj.metadata);
			const exitCode = meta.exit_code ?? meta.exitCode ?? meta.exit;
			if (
				typeof exitCode === "number" &&
				exitCode !== 0 &&
				!inner.includes(`exit code: ${exitCode}`)
			) {
				return `${inner.trimEnd()}\n[exit code: ${exitCode}]`;
			}
			return inner;
		}
		if (typeof obj.error === "string") return obj.error;
		const nestedError = textOrNull(objectOrEmpty(obj.error).message);
		if (nestedError) return nestedError;
	}
	if (typeof output === "string") return output;
	if (fallbackText?.trim()) return fallbackText;
	try {
		return JSON.stringify(output, null, 2);
	} catch {
		return String(output);
	}
}

export function extractErrorBadge(
	status: string | null | undefined,
	output: unknown,
	outputText?: string | null,
): string | undefined {
	const obj = parseOutputObject(output);
	if (obj) {
		const meta = objectOrEmpty(obj.metadata);
		if (meta.timeout === true || meta.status === "timeout") {
			return "timeout";
		}
		if (meta.interrupted === true || meta.status === "killed") {
			return "cancelled";
		}
		const exitCode =
			meta.exit_code ??
			meta.exitCode ??
			meta.exit ??
			obj.exitCode ??
			obj.exit_code ??
			obj.exit;
		if (
			typeof exitCode === "number" &&
			Number.isFinite(exitCode) &&
			exitCode !== 0
		) {
			return `exit ${exitCode}`;
		}
		if (obj.isError === true || obj.is_error === true) {
			return "error";
		}
	}

	const text = outputText ?? (typeof output === "string" ? output : null);
	if (text) {
		if (/\[timed out\b/iu.test(text)) return "timeout";
		if (/\[(?:stopped|killed by signal):/iu.test(text)) return "cancelled";
		const exitMatch = text.match(
			/(?:The command|Command|Process) exited with code (\d+)|\[exit code:\s*(\d+)\]|exit_code:\s*(\d+)/u,
		);
		const code = exitMatch?.[1] ?? exitMatch?.[2] ?? exitMatch?.[3];
		if (code && code !== "0") return `exit ${code}`;
	}

	if (status) {
		if (/cancel|interrupt/iu.test(status)) return "cancelled";
		if (/timeout/iu.test(status)) return "timeout";
		if (/error|fail|denied|reject/iu.test(status)) return "error";
	}
	return undefined;
}

function strField(
	obj: Record<string, unknown> | null,
	rawText: string | null,
	keys: readonly string[],
): string | null {
	if (obj) {
		for (const key of keys) {
			const val = obj[key];
			if (typeof val === "string" && val.trim()) return val.trim();
		}
	}
	if (rawText) {
		for (const key of keys) {
			const pattern = new RegExp(
				`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`,
				"u",
			);
			const match = rawText.match(pattern);
			if (match?.[1]) {
				try {
					const decoded: unknown = JSON.parse(`"${match[1]}"`);
					if (typeof decoded === "string" && decoded.trim())
						return decoded.trim();
				} catch {
					return match[1];
				}
			}
		}
	}
	return null;
}

function numField(
	obj: Record<string, unknown> | null,
	rawText: string | null,
	keys: readonly string[],
): number | null {
	if (obj) {
		for (const key of keys) {
			const val = obj[key];
			if (typeof val === "number" && Number.isFinite(val)) return val;
		}
	}
	if (rawText) {
		for (const key of keys) {
			const pattern = new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "u");
			const match = rawText.match(pattern);
			if (match?.[1]) {
				const num = Number(match[1]);
				if (Number.isFinite(num)) return num;
			}
		}
	}
	return null;
}

function firstStringFromArray(value: unknown): {
	first: string | null;
	extraCount: number;
} {
	if (!Array.isArray(value)) return { first: null, extraCount: 0 };
	const strings = value
		.filter(
			(entry): entry is string =>
				typeof entry === "string" && entry.trim().length > 0,
		)
		.map((entry) => entry.trim());
	if (!strings.length) return { first: null, extraCount: 0 };
	return { first: strings[0] ?? null, extraCount: strings.length - 1 };
}

function formatLineMeta(
	obj: Record<string, unknown> | null,
	rawText: string | null,
): string | undefined {
	const startLine = numField(obj, rawText, [
		"StartLine",
		"startLine",
		"start_line",
		"offset",
	]);
	const endLine = numField(obj, rawText, ["EndLine", "endLine", "end_line"]);
	if (startLine !== null && endLine !== null)
		return `#L${startLine}-${endLine}`;
	if (startLine !== null) {
		const limit = numField(obj, rawText, ["limit"]);
		return limit !== null
			? `#L${startLine}-${startLine + limit}`
			: `#L${startLine}`;
	}
	return undefined;
}

export function verbForTool(
	name: string,
	category?: ToolCategory | null,
): ToolVerb {
	const lower = name.toLowerCase();
	if (/^(?:activate_|use_|load_)?skills?$|_skills?$/u.test(lower))
		return "skill";
	if (/search_web|websearch|web_search/u.test(lower)) return "webSearch";
	if (/read_url|webfetch|web_fetch|fetch_url/u.test(lower)) return "fetchUrl";
	if (/open_page/u.test(lower)) return "openPage";
	if (/grep|search_content|ripgrep|codesearch|find_in_page|search/u.test(lower))
		return "search";
	if (/find_by_name|glob|find_file/u.test(lower)) return "find";
	if (/list_dir|list_directory|read_directory|^ls$|^list$/u.test(lower))
		return "list";
	if (
		/view_file|read_file|read_image|^read$|view_code|view_outline|view_image/u.test(
			lower,
		)
	)
		return "read";
	if (/replace_file|multi_replace|edit|apply_patch|patch/u.test(lower))
		return "edit";
	if (/write_to_file|write_file|^write$|create_file/u.test(lower))
		return "write";
	if (
		/run_command|exec_command|shell_command|bash|shell|terminal|write_stdin|command_status|send_command_input|job_|^run_code$|^execute$|^exec$|^wait$|^sleep$|^js$|background_/u.test(
			lower,
		)
	)
		return "command";
	if (
		/subagent|delegate_task|spawn_agent|send_input|close_agent|resume_agent|wait_agent|list_agents|interrupt_agent|followup_task|send_message|^agent$|^task$|agent_output/u.test(
			lower,
		)
	)
		return "subagent";
	if (/todo_write|todowrite/u.test(lower)) return "todo";
	if (
		/ask_user_question|ask_question|request_user_input|^question$/u.test(lower)
	)
		return "question";
	if (
		/update_plan|plan_mode|proposed_plan|create_goal|update_goal|get_goal/u.test(
			lower,
		)
	)
		return "plan";
	if (
		/mcp_tool|call_mcp|mcp__|mcp_resource|list_resources|read_resource/u.test(
			lower,
		)
	)
		return "mcp";
	if (category === "command") return "command";
	if (category === "read") return "read";
	if (category === "write") return "edit";
	return "other";
}

function patchOperations(
	patchText: string,
	rawName: string,
	errorBadge?: string,
): ToolOperation[] {
	const ops: ToolOperation[] = [];
	for (const match of patchText.matchAll(
		/\*\*\* (Add|Update|Delete) File: (.+)/gu,
	)) {
		const action = match[1];
		const file = match[2]?.trim();
		if (!file) continue;
		ops.push({
			verb: action === "Add" ? "write" : "edit",
			rawName,
			target: shortenDisplayPath(file),
			fullTarget: file,
			meta: action === "Delete" ? "delete" : undefined,
			errorBadge,
		});
	}
	if (ops.length > 0) return ops;

	for (const match of patchText.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gmu)) {
		const file = match[1]?.trim();
		if (!file || file === "/dev/null") continue;
		ops.push({
			verb: "edit",
			rawName,
			target: shortenDisplayPath(file),
			fullTarget: file,
			errorBadge,
		});
	}
	return ops;
}

function skipJsString(
	source: string,
	start: number,
): {
	value: string;
	end: number;
} {
	const quote = source[start];
	let out = "";
	let i = start + 1;
	while (i < source.length) {
		const ch = source[i];
		if (ch === quote) {
			return { value: out, end: i + 1 };
		}
		if (ch === "\\") {
			const next = source[i + 1];
			if (next === undefined) break;
			if (next === "n") out += "\n";
			else if (next === "r") out += "\r";
			else if (next === "t") out += "\t";
			else out += next;
			i += 2;
			continue;
		}
		if (quote === "`" && ch === "$" && source[i + 1] === "{") {
			let depth = 1;
			let j = i + 2;
			while (j < source.length && depth > 0) {
				const inner = source[j];
				if (inner === "'" || inner === '"' || inner === "`") {
					j = skipJsString(source, j).end;
					continue;
				}
				if (inner === "{") depth += 1;
				else if (inner === "}") depth -= 1;
				j += 1;
			}
			out += source.slice(i, j);
			i = j;
			continue;
		}
		out += ch;
		i += 1;
	}
	return { value: out, end: source.length };
}

function skipStringOrComment(source: string, index: number): number | null {
	const ch = source[index];
	if (ch === "'" || ch === '"' || ch === "`") {
		return Math.max(skipJsString(source, index).end, index + 1);
	}
	if (ch === "/" && source[index + 1] === "/") {
		const nl = source.indexOf("\n", index + 2);
		return nl === -1 ? source.length : nl + 1;
	}
	if (ch === "/" && source[index + 1] === "*") {
		const end = source.indexOf("*/", index + 2);
		return end === -1 ? source.length : end + 2;
	}
	return null;
}

/** Replace string literals and comments with spaces while preserving byte offsets. */
function maskJsStringsAndComments(source: string): string {
	let out = "";
	let lastPlain = 0;
	let i = 0;
	while (i < source.length) {
		const skipped = skipStringOrComment(source, i);
		if (skipped !== null) {
			if (i > lastPlain) out += source.slice(lastPlain, i);
			const len = Math.max(skipped - i, 1);
			out += " ".repeat(len);
			i += len;
			lastPlain = i;
			continue;
		}
		i += 1;
	}
	if (lastPlain === 0) return source;
	if (lastPlain < source.length) out += source.slice(lastPlain);
	return out;
}

function skipWsAndComments(source: string, index: number): number {
	let i = index;
	while (i < source.length) {
		const ch = source[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i += 1;
			continue;
		}
		if (ch === "/" && (source[i + 1] === "/" || source[i + 1] === "*")) {
			const skipped = skipStringOrComment(source, i);
			if (skipped !== null) {
				i = Math.max(skipped, i + 1);
				continue;
			}
		}
		break;
	}
	return i;
}

function findMatchingDelimiter(
	source: string,
	openIndex: number,
	openChar: string,
	closeChar: string,
): number {
	let depth = 1;
	let i = openIndex + 1;
	while (i < source.length) {
		const skipped = skipStringOrComment(source, i);
		if (skipped !== null) {
			i = Math.max(skipped, i + 1);
			continue;
		}
		const ch = source[i];
		if (ch === openChar) depth += 1;
		else if (ch === closeChar) {
			depth -= 1;
			if (depth === 0) return i;
		}
		i += 1;
	}
	return -1;
}

function scanUnknownJsExpr(source: string, index: number): number {
	let i = index;
	let parenDepth = 0;
	let bracketDepth = 0;
	let braceDepth = 0;
	while (i < source.length) {
		const skipped = skipStringOrComment(source, i);
		if (skipped !== null) {
			i = Math.max(skipped, i + 1);
			continue;
		}
		const ch = source[i];
		if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
			if (ch === "," || ch === "}" || ch === "]" || ch === ")") return i;
		}
		if (ch === "(") parenDepth += 1;
		else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
		else if (ch === "[") bracketDepth += 1;
		else if (ch === "]") bracketDepth = Math.max(0, bracketDepth - 1);
		else if (ch === "{") braceDepth += 1;
		else if (ch === "}") braceDepth = Math.max(0, braceDepth - 1);
		i += 1;
	}
	return i;
}

function parseJsValue(
	source: string,
	index: number,
	bindings?: ReadonlyMap<string, unknown>,
	depth = 0,
): { value: unknown; next: number } {
	let i = skipWsAndComments(source, index);
	const ch = source[i];
	if (ch === undefined) return { value: undefined, next: i };
	if (depth > 24) {
		return {
			value: undefined,
			next: Math.max(scanUnknownJsExpr(source, i), i + 1),
		};
	}

	if (ch === "'" || ch === '"' || ch === "`") {
		const str = skipJsString(source, i);
		if (ch === "`" && bindings?.size && str.value.includes("${")) {
			const interpolated = str.value.replaceAll(
				/\$\{([a-zA-Z_$][a-zA-Z0-9_$]*)\}/gu,
				(full, name: string) => {
					const bound = bindings.get(name);
					if (typeof bound === "string" || typeof bound === "number") {
						return String(bound);
					}
					return full;
				},
			);
			return { value: interpolated, next: str.end };
		}
		return { value: str.value, next: str.end };
	}

	if (ch === "{") {
		const record: Record<string, unknown> = {};
		i += 1;
		while (i < source.length) {
			i = skipWsAndComments(source, i);
			const iterStart = i;
			if (source[i] === undefined) break;
			if (source[i] === "}") return { value: record, next: i + 1 };
			if (source[i] === ",") {
				i += 1;
				continue;
			}
			if (source.startsWith("...", i)) {
				i = Math.max(scanUnknownJsExpr(source, i + 3), i + 3);
				continue;
			}
			let key: string | null = null;
			const keyCh = source[i];
			if (keyCh === "'" || keyCh === '"' || keyCh === "`") {
				const parsedKey = skipJsString(source, i);
				key = parsedKey.value;
				i = Math.max(parsedKey.end, iterStart + 1);
			} else if (keyCh && /[a-zA-Z0-9_$]/u.test(keyCh)) {
				const keyStart = i;
				while (i < source.length && /[a-zA-Z0-9_$]/u.test(source[i] ?? "")) {
					i += 1;
				}
				key = source.slice(keyStart, i);
			} else {
				i = Math.max(scanUnknownJsExpr(source, i), iterStart + 1);
				continue;
			}
			i = skipWsAndComments(source, i);
			if (source[i] === ":") {
				const parsedVal = parseJsValue(source, i + 1, bindings, depth + 1);
				record[key] = parsedVal.value;
				i = Math.max(parsedVal.next, iterStart + 1);
			} else {
				record[key] = bindings?.get(key);
				if (source[i] !== undefined && source[i] !== "," && source[i] !== "}") {
					i = Math.max(scanUnknownJsExpr(source, i), iterStart + 1);
				}
			}
			if (i <= iterStart) i = iterStart + 1;
		}
		return { value: record, next: i };
	}

	if (ch === "[") {
		const arr: unknown[] = [];
		i += 1;
		while (i < source.length) {
			i = skipWsAndComments(source, i);
			const iterStart = i;
			if (source[i] === undefined) break;
			if (source[i] === "]") return { value: arr, next: i + 1 };
			if (source[i] === ",") {
				i += 1;
				continue;
			}
			const item = parseJsValue(source, i, bindings, depth + 1);
			arr.push(item.value);
			i = Math.max(item.next, iterStart + 1);
		}
		return { value: arr, next: i };
	}

	const numMatch = source.slice(i).match(/^-?\d+(?:\.\d+)?/u);
	if (numMatch && !/[a-zA-Z_$]/u.test(source[i + numMatch[0].length] ?? "")) {
		return {
			value: Number(numMatch[0]),
			next: i + numMatch[0].length,
		};
	}

	const identMatch = source.slice(i).match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/u);
	if (identMatch) {
		const word = identMatch[0];
		const after = skipWsAndComments(source, i + word.length);
		const boundary = source[after];
		if (
			boundary === undefined ||
			boundary === "," ||
			boundary === "}" ||
			boundary === "]" ||
			boundary === ")"
		) {
			if (word === "true") return { value: true, next: after };
			if (word === "false") return { value: false, next: after };
			if (word === "null" || word === "undefined")
				return { value: undefined, next: after };
			return { value: bindings?.get(word), next: after };
		}
	}

	const end = Math.max(scanUnknownJsExpr(source, i), i + 1);
	return { value: undefined, next: end };
}

function collectJsConstBindings(
	script: string,
	maskedScript: string,
): Map<string, unknown> {
	const map = new Map<string, unknown>();
	const declPattern = /(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=/gu;
	for (const match of maskedScript.matchAll(declPattern)) {
		const name = match[1];
		if (!name) continue;
		const start = (match.index ?? 0) + match[0].length;
		const { value } = parseJsValue(script, start, map);
		if (value !== undefined) map.set(name, value);
	}
	return map;
}

function pushLoopPairCmds(value: unknown, cmds: string[]): void {
	if (!Array.isArray(value)) return;
	if (
		value.length === 2 &&
		typeof value[0] === "string" &&
		typeof value[1] === "string" &&
		value[1].trim()
	) {
		cmds.push(value[1].trim());
		return;
	}
	for (const item of value) {
		if (Array.isArray(item)) pushLoopPairCmds(item, cmds);
	}
}

function loopCommandCandidates(script: string): string[] {
	const cmds: string[] = [];
	let i = 0;
	while (i < script.length) {
		const skipped = skipStringOrComment(script, i);
		if (skipped !== null) {
			i = Math.max(skipped, i + 1);
			continue;
		}
		if (script[i] === "[") {
			const parsed = parseJsValue(script, i);
			pushLoopPairCmds(parsed.value, cmds);
			i = Math.max(parsed.next, i + 1);
			continue;
		}
		i += 1;
	}
	return cmds;
}

function collectJsToolAliases(maskedScript: string): Map<string, string> {
	const aliases = new Map<string, string>();
	const destructureRe = /(?:const|let|var)\s*\{([^}]+)\}\s*=\s*tools\b/gu;
	for (const match of maskedScript.matchAll(destructureRe)) {
		const body = match[1] ?? "";
		for (const part of body.split(",")) {
			const cleaned = part.trim();
			if (!cleaned) continue;
			const colon = cleaned.indexOf(":");
			if (colon >= 0) {
				const rawName = cleaned.slice(0, colon).trim();
				const localName = cleaned
					.slice(colon + 1)
					.replace(/=.*$/u, "")
					.trim();
				if (rawName && localName) aliases.set(localName, rawName);
			} else {
				const rawName = cleaned.replace(/=.*$/u, "").trim();
				if (rawName) aliases.set(rawName, rawName);
			}
		}
	}
	return aliases;
}

const KNOWN_CODEX_DIRECT_TOOLS = new Set([
	"exec_command",
	"shell_command",
	"write_stdin",
	"apply_patch",
	"web__run",
	"update_plan",
	"read_file",
	"grep_files",
	"list_dir",
	"view_image",
]);

function extractToolCallsFromJs(
	script: string,
	aliases: ReadonlyMap<string, string>,
): Array<{ name: string; argsText: string }> {
	const calls: Array<{ name: string; argsText: string }> = [];
	const pushCall = (name: string, openParen: number): number => {
		const closeParen = findMatchingDelimiter(script, openParen, "(", ")");
		const argsText =
			closeParen !== -1
				? script.slice(openParen + 1, closeParen).trim()
				: script.slice(openParen + 1, openParen + 300).trim();
		calls.push({ name, argsText });
		return closeParen !== -1 ? closeParen + 1 : openParen + 1;
	};

	let i = 0;
	while (i < script.length) {
		const skipped = skipStringOrComment(script, i);
		if (skipped !== null) {
			i = Math.max(skipped, i + 1);
			continue;
		}
		const ch = script[i];
		if (script.startsWith("tools.", i)) {
			const rest = script.slice(i + 6);
			const match = rest.match(/^([a-zA-Z0-9_]+)\s*\(/u);
			if (match?.[1]) {
				const openParen = i + 6 + match[0].length - 1;
				i = pushCall(match[1], openParen);
				continue;
			}
		}
		if (script.startsWith("tools[", i)) {
			const parsedKey = parseJsValue(script, i + 6);
			const afterClose = skipWsAndComments(script, parsedKey.next);
			if (typeof parsedKey.value === "string" && script[afterClose] === "]") {
				const afterBracket = skipWsAndComments(script, afterClose + 1);
				if (script[afterBracket] === "(") {
					i = pushCall(parsedKey.value, afterBracket);
					continue;
				}
			}
		}
		const prevChar = i > 0 ? script[i - 1] : "";
		if (
			ch &&
			/[a-zA-Z_$]/u.test(ch) &&
			(!prevChar || !/[a-zA-Z0-9_$.]/u.test(prevChar))
		) {
			const identMatch = script.slice(i).match(/^([a-zA-Z0-9_]+)\s*\(/u);
			const local = identMatch?.[1];
			if (local) {
				const mapped =
					aliases.get(local) ??
					(KNOWN_CODEX_DIRECT_TOOLS.has(local) ? local : null);
				if (mapped) {
					const openParen = i + identMatch[0].length - 1;
					i = pushCall(mapped, openParen);
					continue;
				}
			}
		}
		i += 1;
	}
	return calls;
}

function unrollArrayLoopOps(
	script: string,
	maskedScript: string,
	callName: string,
	argsText: string,
	bindings: ReadonlyMap<string, unknown>,
	errorBadge?: string,
	depth = 0,
): ToolOperation[] {
	// Support `for (const v of arr)` or `arr.map((v) => tools.fn(...))` outside strings/comments
	const loopMatch =
		maskedScript.match(
			/for\s*\(\s*(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+of\s+([a-zA-Z_$][a-zA-Z0-9_$]*|\[[^\]]+\])/u,
		) ??
		maskedScript.match(
			/([a-zA-Z_$][a-zA-Z0-9_$]*|\[[^\]]+\])\s*\.\s*map\s*\(\s*(?:async\s*)?\(?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/u,
		);
	if (!loopMatch) return [];
	const varName = loopMatch[0].startsWith("for") ? loopMatch[1] : loopMatch[2];
	const arrayExprOffset =
		(loopMatch.index ?? 0) +
		(loopMatch[0].startsWith("for")
			? loopMatch[0].lastIndexOf(loopMatch[2] ?? "")
			: 0);
	const arrayExpr = loopMatch[0].startsWith("for")
		? loopMatch[2]
		: loopMatch[1];
	if (!varName || !arrayExpr) return [];

	const itemsValue = arrayExpr.startsWith("[")
		? parseJsValue(script, arrayExprOffset, bindings).value
		: bindings.get(arrayExpr);
	if (!Array.isArray(itemsValue) || !itemsValue.length) return [];
	const varPattern = new RegExp(`\\b${varName}\\b`, "u");
	if (!varPattern.test(argsText)) return [];

	const ops: ToolOperation[] = [];
	for (const entry of itemsValue.slice(0, 20)) {
		if (typeof entry !== "string" && typeof entry !== "number") continue;
		const iterBindings = new Map(bindings);
		iterBindings.set(varName, entry);
		const parsed = parseJsValue(argsText, 0, iterBindings).value;
		const normalized = normalizeToolOperations(
			{
				name: callName,
				input:
					typeof parsed === "string" ||
					(parsed && typeof parsed === "object" && !Array.isArray(parsed))
						? parsed
						: argsText,
			},
			undefined,
			depth + 1,
		).map((op) => (errorBadge ? { ...op, errorBadge } : op));
		ops.push(...normalized);
	}
	return ops;
}

function embeddedJsOperations(
	script: string,
	errorBadge?: string,
	depth = 0,
): ToolOperation[] {
	const maskedScript = maskJsStringsAndComments(script);
	const bindings = collectJsConstBindings(script, maskedScript);
	const aliases = collectJsToolAliases(maskedScript);
	const calls = extractToolCallsFromJs(script, aliases);
	if (calls.length > 0) {
		const ops: ToolOperation[] = [];
		for (const call of calls) {
			if (ops.length >= 30) break;
			const unrolled = unrollArrayLoopOps(
				script,
				maskedScript,
				call.name,
				call.argsText,
				bindings,
				errorBadge,
				depth,
			);
			if (unrolled.length > 0) {
				ops.push(...unrolled);
				continue;
			}
			const parsed = parseJsValue(call.argsText, 0, bindings).value;
			const argObj =
				parsed && typeof parsed === "object" && !Array.isArray(parsed)
					? (parsed as Record<string, unknown>)
					: null;
			if (
				call.name === "exec_command" &&
				!textOrNull(argObj?.cmd) &&
				!textOrNull(argObj?.command)
			) {
				const cmds = loopCommandCandidates(script);
				if (cmds.length > 0) {
					for (const cmd of cmds) {
						if (ops.length >= 30) break;
						ops.push({
							verb: "command",
							rawName: "exec_command",
							target: singleLinePreview(cmd, 140),
							fullTarget: cmd,
							errorBadge,
						});
					}
					continue;
				}
			}
			const resolvedInput =
				typeof parsed === "string" ? parsed : (argObj ?? call.argsText);
			const normalized = normalizeToolOperations(
				{ name: call.name, input: resolvedInput },
				undefined,
				depth + 1,
			).map((op) => (errorBadge ? { ...op, errorBadge } : op));
			ops.push(...normalized);
		}
		return ops.slice(0, 30);
	}

	if (script.includes("*** Begin Patch")) {
		const patched = patchOperations(script, "apply_patch", errorBadge);
		if (patched.length > 0) return patched.slice(0, 30);
	}

	return [];
}

function normalizeWebSearch(
	rawName: string,
	obj: Record<string, unknown> | null,
	rawText: string | null,
	errorBadge?: string,
): ToolOperation {
	if (Array.isArray(obj?.open) && obj.open.length > 0) {
		const first = objectOrEmpty(obj.open[0]);
		const target =
			textOrNull(first.url) ??
			textOrNull(first.ref_id) ??
			textOrNull(first.id) ??
			"";
		return {
			verb: "openPage",
			rawName,
			target: singleLinePreview(target, 140),
			fullTarget: target || undefined,
			meta: obj.open.length > 1 ? `+${obj.open.length - 1}` : undefined,
			errorBadge,
		};
	}

	if (Array.isArray(obj?.find) && obj.find.length > 0) {
		const first = objectOrEmpty(obj.find[0]);
		const pattern =
			textOrNull(first.pattern) ??
			textOrNull(first.q) ??
			textOrNull(first.query) ??
			"";
		const refId = textOrNull(first.ref_id) ?? undefined;
		const target = pattern || refId || "";
		return {
			verb: "search",
			rawName,
			target: singleLinePreview(target, 120),
			fullTarget: target || undefined,
			meta:
				pattern && refId
					? singleLinePreview(refId, 48)
					: obj.find.length > 1
						? `+${obj.find.length - 1}`
						: undefined,
			errorBadge,
		};
	}

	const searchItems = Array.isArray(obj?.search_query)
		? obj.search_query
		: Array.isArray(obj?.image_query)
			? obj.image_query
			: null;
	if (searchItems && searchItems.length > 0) {
		const first = objectOrEmpty(searchItems[0]);
		const q = textOrNull(first.q) ?? textOrNull(first.query) ?? "";
		return {
			verb: "webSearch",
			rawName,
			target: q ? singleLinePreview(q, 120) : "",
			fullTarget: q || undefined,
			meta: searchItems.length > 1 ? `+${searchItems.length - 1}` : undefined,
			errorBadge,
		};
	}

	const action = obj?.action ? objectOrEmpty(obj.action) : null;
	const actionType = action ? textOrNull(action.type) : null;
	if (actionType === "open_page") {
		const url = textOrNull(action?.url) ?? "";
		return {
			verb: "openPage",
			rawName,
			target: singleLinePreview(url, 140),
			fullTarget: url || undefined,
			errorBadge,
		};
	}
	if (actionType === "find_in_page") {
		const pattern = textOrNull(action?.pattern) ?? "";
		const url = textOrNull(action?.url) ?? undefined;
		return {
			verb: "search",
			rawName,
			target: singleLinePreview(pattern, 120),
			fullTarget: url ?? (pattern || undefined),
			meta: url ? singleLinePreview(url, 48) : undefined,
			errorBadge,
		};
	}

	const actionQueries = firstStringFromArray(action?.queries);
	const rootQueries = firstStringFromArray(obj?.queries);
	const query =
		textOrNull(action?.query) ??
		actionQueries.first ??
		strField(obj, rawText, ["query", "Query", "q"]) ??
		rootQueries.first ??
		"";
	const extra = actionQueries.first
		? actionQueries.extraCount
		: rootQueries.extraCount;
	return {
		verb: "webSearch",
		rawName,
		target: query ? singleLinePreview(query, 120) : "",
		fullTarget: query || undefined,
		meta: extra > 0 ? `+${extra}` : undefined,
		errorBadge,
	};
}

function summarizeTodos(
	obj: Record<string, unknown> | null,
	rawText: string | null,
	rawName: string,
	errorBadge?: string,
): ToolOperation {
	const items = Array.isArray(obj?.todos)
		? obj.todos
		: Array.isArray(obj?.plan)
			? obj.plan
			: [];
	let completed = 0;
	let firstLabel = "";
	for (const entry of items) {
		const rec = objectOrEmpty(entry);
		const status = textOrNull(rec.status)?.toLowerCase() ?? "";
		if (status === "completed" || status === "done") completed += 1;
		if (!firstLabel) {
			firstLabel =
				textOrNull(rec.content) ??
				textOrNull(rec.step) ??
				textOrNull(rec.title) ??
				"";
		}
	}
	const countMeta =
		items.length > 0 ? `${completed}/${items.length}` : undefined;
	const markdownPlan =
		typeof obj?.plan === "string"
			? singleLinePreview(obj.plan.replace(/^#+\s*/gmu, ""), 100)
			: "";
	const goalParts = [
		strField(obj, rawText, ["action"]),
		strField(obj, rawText, ["goal_id", "goalId"]),
	].filter(Boolean);
	const goalLabel =
		strField(obj, rawText, ["objective", "title", "toolSummary"]) ??
		(goalParts.length > 0 ? goalParts.join(" ") : null);
	const target = firstLabel
		? singleLinePreview(firstLabel, 100)
		: (textOrNull(obj?.explanation) ??
			(markdownPlan ||
				(goalLabel ? singleLinePreview(goalLabel, 120) : rawName)));
	return {
		verb: verbForTool(rawName),
		rawName,
		target,
		meta: countMeta,
		errorBadge,
	};
}

function unwrapShellWrapper(args: readonly string[]): string | null {
	if (args.length < 2) return null;
	const exe = pathBase(args[0] ?? "");
	if (
		(exe === "bash" || exe === "sh" || exe === "zsh") &&
		(args[1] === "-c" || args[1] === "-lc") &&
		args[2]
	) {
		return args.slice(2).join(" ").trim() || null;
	}
	return null;
}

function pathBase(value: string): string {
	const idx = value.lastIndexOf("/");
	return idx >= 0 ? value.slice(idx + 1) : value;
}

function commandString(
	obj: Record<string, unknown> | null,
	rawText: string | null,
): string | null {
	const direct = strField(obj, rawText, [
		"CommandLine",
		"command_line",
		"command",
		"cmd",
	]);
	if (direct) {
		const args = Array.isArray(obj?.args)
			? obj.args
					.filter((arg): arg is string => typeof arg === "string")
					.join(" ")
			: "";
		return args ? `${direct} ${args}` : direct;
	}
	const cmdArr = Array.isArray(obj?.command)
		? obj.command
		: Array.isArray(obj?.cmd)
			? obj.cmd
			: null;
	if (cmdArr) {
		const parts = cmdArr.filter(
			(part): part is string => typeof part === "string",
		);
		const unwrapped = unwrapShellWrapper(parts);
		if (unwrapped) return unwrapped;
		const joined = parts.join(" ").trim();
		if (joined) return joined;
	}
	return null;
}

function splitShellStatements(script: string): string[] {
	const lines = script.split(/\r?\n/u);
	const statements: string[] = [];
	let current: string[] = [];
	let heredocEnd: string | null = null;
	let quote: "'" | '"' | null = null;

	const flush = () => {
		const joined = current.join("\n").trim();
		current = [];
		if (joined && !joined.startsWith("#")) statements.push(joined);
	};

	for (const line of lines) {
		if (heredocEnd !== null) {
			if (line.trim() === heredocEnd) {
				heredocEnd = null;
				flush();
			}
			continue;
		}
		current.push(line);
		for (let i = 0; i < line.length; i += 1) {
			const ch = line[i];
			if (quote) {
				if (ch === "\\" && quote === '"') {
					i += 1;
					continue;
				}
				if (ch === quote) quote = null;
			} else if (ch === "'" || ch === '"') {
				quote = ch;
			}
		}
		if (quote !== null) continue;

		const heredoc = line.match(/<<[-~]?\s*(['"]?)([A-Za-z0-9_]+)\1\s*$/u);
		if (heredoc?.[2]) {
			heredocEnd = heredoc[2];
			continue;
		}
		if (/\\\s*$/u.test(line)) continue;
		flush();
		if (statements.length >= 15) break;
	}
	flush();
	return statements;
}

function formatDurationMs(ms: number): string {
	if (ms >= 60_000) {
		const mins = Math.round((ms / 60_000) * 10) / 10;
		return `${mins}m`;
	}
	if (ms >= 1000) {
		const secs = Math.round((ms / 1000) * 10) / 10;
		return `${secs}s`;
	}
	return `${ms}ms`;
}

function resolveCommandTarget(
	rawName: string,
	obj: Record<string, unknown> | null,
	rawText: string | null,
): { target: string; fullTarget?: string; meta?: string } {
	if (rawName === "sleep" || rawName === "wait") {
		const ms = numField(obj, rawText, ["duration_ms", "durationMs", "ms"]);
		if (ms !== null) {
			const formatted = formatDurationMs(ms);
			return { target: `${rawName} ${formatted}` };
		}
	}
	const cmd = commandString(obj, rawText);
	const summary = strField(obj, rawText, [
		"toolSummary",
		"completion_summary",
		"description",
		"title",
		"Action",
	]);
	if (cmd) {
		return {
			target: singleLinePreview(cmd, 140),
			fullTarget: cmd,
			meta: summary && summary.length <= 48 ? summary : undefined,
		};
	}
	if (rawName === "write_stdin") {
		const chars = strField(obj, rawText, ["chars"]);
		if (chars) return { target: singleLinePreview(chars, 80) };
	}
	const numId = numField(obj, rawText, ["session_id", "cell_id"]);
	const idVal =
		strField(obj, rawText, [
			"TaskId",
			"CommandId",
			"job_id",
			"shell_id",
			"task_id",
			"taskId",
			"cell_id",
			"id",
		]) ?? (numId !== null ? `#${numId}` : null);
	const codeSnippet = strField(obj, rawText, ["code", "script"]);
	const fallback =
		summary ??
		idVal ??
		(codeSnippet ? singleLinePreview(codeSnippet, 120) : null) ??
		(rawText && !rawText.trimStart().startsWith("{")
			? singleLinePreview(rawText, 120)
			: rawName);
	return { target: fallback };
}

export function normalizeToolOperations(
	call: ToolCallLike,
	result?: ToolResultLike,
	depth = 0,
): ToolOperation[] {
	const rawName = call.name?.trim() || "tool";
	const { obj, rawText } = parseInput(call.input);
	const errorBadge = extractErrorBadge(
		result?.status ?? call.status,
		result?.output,
		result?.text,
	);

	// Codex custom_tool_call/function_call `apply_patch`, DSH `apply_patch`, or OpenCode `patchText`
	const patchSource =
		textOrNull(obj?.patchText) ??
		(rawName === "apply_patch" ? (textOrNull(obj?.input) ?? rawText) : null);
	if (patchSource) {
		const patched = patchOperations(patchSource, rawName, errorBadge);
		if (patched.length > 0) return patched.slice(0, 30);
	}

	// Codex JS code-mode `exec` / `js` & OpenCode `execute` / `run_code`
	const execScript =
		textOrNull(obj?.code) ?? textOrNull(obj?.script) ?? rawText;
	if (
		depth < 2 &&
		(rawName === "exec" ||
			rawName === "execute" ||
			rawName === "run_code" ||
			rawName === "js") &&
		execScript
	) {
		const embedded = embeddedJsOperations(execScript, errorBadge, depth);
		if (embedded.length > 0) return embedded;
	}

	if (rawName === "web__run" || rawName === "web_run") {
		return [normalizeWebSearch(rawName, obj, rawText, errorBadge)];
	}

	if (
		depth < 2 &&
		(rawName === "multi_tool_use.parallel" || rawName === "parallel") &&
		Array.isArray(obj?.tool_uses)
	) {
		const ops: ToolOperation[] = [];
		for (const use of obj.tool_uses.slice(0, 30)) {
			const rec = objectOrEmpty(use);
			const recipient = textOrNull(rec.recipient_name) ?? "tool";
			const cleanName = recipient.replace(/^(?:functions|tools)\./u, "");
			const normalized = normalizeToolOperations(
				{ name: cleanName, input: rec.parameters },
				undefined,
				depth + 1,
			).map((op) => (errorBadge ? { ...op, errorBadge } : op));
			ops.push(...normalized);
		}
		if (ops.length > 0) return ops.slice(0, 30);
	}

	const rawVerb = verbForTool(rawName, call.category);
	const verb =
		rawName === "str_replace_editor" && obj?.command === "view"
			? "read"
			: rawVerb;
	const multiPaths = firstStringFromArray(obj?.paths);
	const pathVal =
		strField(obj, rawText, [
			"AbsolutePath",
			"absolute_path",
			"TargetFile",
			"target_file",
			"filePath",
			"file_path",
			"Path",
			"path",
			"file",
			"DirectoryPath",
			"dir_path",
			"SearchDirectory",
			"SearchPath",
			"File",
		]) ?? multiPaths.first;

	if (
		verb === "read" ||
		verb === "edit" ||
		verb === "write" ||
		verb === "list"
	) {
		const target = pathVal ? shortenDisplayPath(pathVal) : "";
		const multiMeta =
			multiPaths.extraCount > 0 ? `+${multiPaths.extraCount}` : undefined;
		const meta =
			verb === "read"
				? (formatLineMeta(obj, rawText) ??
					strField(obj, rawText, ["ItemPath"]) ??
					multiMeta)
				: multiMeta;
		return [
			{
				verb,
				rawName,
				target,
				fullTarget: pathVal ?? undefined,
				meta,
				errorBadge,
			},
		];
	}

	if (verb === "search" || verb === "find") {
		const queriesArr = firstStringFromArray(obj?.queries);
		const query =
			strField(obj, rawText, [
				"Query",
				"query",
				"Pattern",
				"pattern",
				"glob",
				"regex",
			]) ?? queriesArr.first;
		const inPath = pathVal ? shortenDisplayPath(pathVal) : undefined;
		const extra =
			queriesArr.extraCount > 0 ? `+${queriesArr.extraCount}` : undefined;
		return [
			{
				verb,
				rawName,
				target: query ? singleLinePreview(query, 120) : (inPath ?? ""),
				fullTarget: pathVal ?? query ?? undefined,
				meta: (query && inPath ? inPath : undefined) ?? extra,
				errorBadge,
			},
		];
	}

	if (verb === "command") {
		const cmd = commandString(obj, rawText);
		if (cmd) {
			const statements = splitShellStatements(cmd);
			if (statements.length > 1) {
				const summary = strField(obj, rawText, [
					"toolSummary",
					"completion_summary",
					"description",
					"title",
					"Action",
				]);
				const meta = summary && summary.length <= 48 ? summary : undefined;
				return statements.map((stmt, index) => ({
					verb,
					rawName,
					target: singleLinePreview(stmt, 140),
					fullTarget: stmt,
					meta: index === 0 ? meta : undefined,
					errorBadge,
				}));
			}
		}
		const resolved = resolveCommandTarget(rawName, obj, rawText);
		return [
			{
				verb,
				rawName,
				target: resolved.target,
				fullTarget: resolved.fullTarget,
				meta: resolved.meta,
				errorBadge,
			},
		];
	}

	if (verb === "webSearch" || rawName === "web_search_call") {
		return [normalizeWebSearch(rawName, obj, rawText, errorBadge)];
	}

	if (verb === "fetchUrl" || verb === "openPage") {
		const url = strField(obj, rawText, ["Url", "url"]);
		return [
			{
				verb,
				rawName,
				target: url ? singleLinePreview(url, 140) : "",
				fullTarget: url ?? undefined,
				errorBadge,
			},
		];
	}

	if (verb === "skill") {
		const skillName =
			strField(obj, rawText, ["name", "id", "skill", "toolSummary"]) ?? rawName;
		const args = strField(obj, rawText, ["arguments"]);
		return [
			{
				verb,
				rawName,
				target: singleLinePreview(skillName, 120),
				meta: args ? singleLinePreview(args, 48) : undefined,
				errorBadge,
			},
		];
	}

	if (verb === "subagent") {
		const subagents = Array.isArray(obj?.Subagents)
			? objectOrEmpty(obj.Subagents[0])
			: null;
		const candidate =
			(subagents
				? (textOrNull(subagents.Role) ?? textOrNull(subagents.TypeName))
				: null) ??
			strField(obj, rawText, [
				"task_name",
				"target",
				"toolSummary",
				"description",
				"Role",
				"role",
				"subagent_type",
				"agent_type",
				"TypeName",
				"Recipient",
				"agent_id",
				"id",
			]);
		const fallbackMsg = strField(obj, rawText, [
			"message",
			"Message",
			"Prompt",
			"prompt",
			"Action",
		]);
		const usableMsg =
			fallbackMsg && !/^gAAAAA[A-Za-z0-9_-]{20,}$/u.test(fallbackMsg)
				? fallbackMsg
				: null;
		const desc = candidate ?? usableMsg;
		return [
			{
				verb,
				rawName,
				target: desc ? singleLinePreview(desc, 120) : rawName,
				errorBadge,
			},
		];
	}

	if (verb === "mcp") {
		const server = strField(obj, rawText, ["ServerName", "server"]);
		const tool = strField(obj, rawText, ["ToolName", "tool"]);
		const combined = [server, tool].filter(Boolean).join(" · ");
		const mcpName = rawName.startsWith("mcp__")
			? rawName.slice(5).split("__").filter(Boolean).join(" · ")
			: "";
		const summary = strField(obj, rawText, [
			"toolSummary",
			"uri",
			"query",
			"libraryId",
			"libraryName",
			"path",
			"url",
		]);
		const target = combined || mcpName || summary || rawName;
		const meta =
			(combined || mcpName) && summary && summary !== target
				? singleLinePreview(summary, 60)
				: undefined;
		return [
			{
				verb,
				rawName,
				target,
				meta,
				errorBadge,
			},
		];
	}

	if (verb === "todo" || verb === "plan") {
		return [summarizeTodos(obj, rawText, rawName, errorBadge)];
	}

	if (verb === "question") {
		const firstQ = Array.isArray(obj?.questions)
			? objectOrEmpty(obj.questions[0])
			: null;
		const questionText =
			(firstQ
				? (textOrNull(firstQ.header) ??
					textOrNull(firstQ.question) ??
					textOrNull(firstQ.title) ??
					textOrNull(firstQ.label))
				: null) ??
			strField(obj, rawText, [
				"question",
				"title",
				"Prompt",
				"prompt",
				"toolSummary",
			]);
		return [
			{
				verb,
				rawName,
				target: questionText ? singleLinePreview(questionText, 120) : "",
				errorBadge,
			},
		];
	}

	if (rawName === "present" && Array.isArray(obj?.files)) {
		const first = objectOrEmpty(obj.files[0]);
		const filePath = textOrNull(first.path) ?? textOrNull(first.file);
		if (filePath) {
			return [
				{
					verb,
					rawName,
					target: shortenDisplayPath(filePath),
					fullTarget: filePath,
					meta: obj.files.length > 1 ? `+${obj.files.length - 1}` : undefined,
					errorBadge,
				},
			];
		}
	}

	if (rawName === "cordis_inspect_query") {
		const parts = [
			textOrNull(obj?.platform),
			textOrNull(obj?.provider),
			textOrNull(obj?.method),
		].filter(Boolean);
		if (parts.length > 0) {
			return [
				{
					verb,
					rawName,
					target: parts.join(" · "),
					errorBadge,
				},
			];
		}
	}

	const durationSec = numField(obj, rawText, ["DurationSeconds"]);
	const fallback =
		strField(obj, rawText, [
			"toolSummary",
			"completion_summary",
			"description",
			"title",
			"subject",
			"objective",
			"instruction",
			"text",
			"Prompt",
			"CronExpression",
			"Action",
			"action",
			"query",
			"path",
			"url",
			"uri",
			"tool",
			"name",
			"id",
		]) ??
		(durationSec !== null ? `${durationSec}s` : null) ??
		(rawText && !rawText.trimStart().startsWith("{")
			? singleLinePreview(rawText, 120)
			: "");

	return [
		{
			verb,
			rawName,
			target: fallback,
			errorBadge,
		},
	];
}
