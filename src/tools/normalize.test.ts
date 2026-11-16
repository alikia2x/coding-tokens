import { describe, expect, test } from "bun:test";
import {
	extractErrorBadge,
	normalizeToolOperations,
	pairToolItems,
	unwrapToolOutput,
} from "./normalize";

describe("tool normalization across harnesses", () => {
	test("normalizes Codex web_search_call, exec_command, apply_patch, code-mode exec, and plan tools", () => {
		expect(
			normalizeToolOperations({
				name: "web_search_call",
				input: {
					action: { type: "search", queries: ["codex rollout schema", "v2"] },
				},
			}),
		).toEqual([
			{
				verb: "webSearch",
				rawName: "web_search_call",
				target: "codex rollout schema",
				fullTarget: "codex rollout schema",
				meta: "+1",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations({
				name: "web_search_call",
				input: {
					action: { type: "open_page", url: "https://example.com/docs" },
				},
			}),
		).toEqual([
			{
				verb: "openPage",
				rawName: "web_search_call",
				target: "https://example.com/docs",
				fullTarget: "https://example.com/docs",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations(
				{
					name: "exec_command",
					input: JSON.stringify({ cmd: "bun test", workdir: "/repo" }),
				},
				{
					output: JSON.stringify({
						output: "1 fail",
						metadata: { exit_code: 2 },
					}),
					text: "1 fail",
				},
			),
		).toEqual([
			{
				verb: "command",
				rawName: "exec_command",
				target: "bun test",
				fullTarget: "bun test",
				meta: undefined,
				errorBadge: "exit 2",
			},
		]);

		// Freeform apply_patch (custom_tool_call)
		const freeformPatch = [
			"*** Begin Patch",
			"*** Update File: /Users/alice/repo/a.ts",
			"@@",
			"-old",
			"+new",
			"*** Add File: /Users/alice/repo/b.ts",
			"+hello",
			"*** End Patch",
		].join("\n");
		expect(
			normalizeToolOperations({ name: "apply_patch", input: freeformPatch }),
		).toEqual([
			{
				verb: "edit",
				rawName: "apply_patch",
				target: "~/repo/a.ts",
				fullTarget: "/Users/alice/repo/a.ts",
				meta: undefined,
				errorBadge: undefined,
			},
			{
				verb: "write",
				rawName: "apply_patch",
				target: "~/repo/b.ts",
				fullTarget: "/Users/alice/repo/b.ts",
				meta: undefined,
				errorBadge: undefined,
			},
		]);

		// JSON-wrapped apply_patch (function_call / DSH)
		expect(
			normalizeToolOperations({
				name: "apply_patch",
				input: { input: freeformPatch },
			}),
		).toHaveLength(2);

		// Codex JS code-mode `exec` both raw and JSON { code }
		const codeModeOps = normalizeToolOperations({
			name: "exec",
			input: {
				code: 'for (const [k, cmd] of [["a", "git status"], ["b", "bun run check"]]) { await tools.exec_command({ cmd }); }',
			},
		});
		expect(codeModeOps.map((op) => [op.verb, op.target])).toEqual([
			["command", "git status"],
			["command", "bun run check"],
		]);

		expect(
			normalizeToolOperations({
				name: "update_plan",
				input: {
					plan: [
						{ step: "Inspect DB", status: "completed" },
						{ step: "Add tests", status: "in_progress" },
					],
				},
			}),
		).toEqual([
			{
				verb: "plan",
				rawName: "update_plan",
				target: "Inspect DB",
				meta: "1/2",
				errorBadge: undefined,
			},
		]);
	});

	test("normalizes DSH, OpenCode, CommandCode, and Antigravity tools uniformly", () => {
		// DSH web_search + bash markers + str_replace_editor view vs edit
		expect(
			normalizeToolOperations({
				name: "web_search",
				input: { queries: ["bun sqlite readonly", "wal mode"] },
			}),
		).toEqual([
			{
				verb: "webSearch",
				rawName: "web_search",
				target: "bun sqlite readonly",
				fullTarget: "bun sqlite readonly",
				meta: "+1",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations(
				{
					name: "bash",
					input: { command: "ls /missing", description: "Check" },
				},
				{ text: "ls: cannot access\n[exit code: 2]", status: "completed" },
			)[0]?.errorBadge,
		).toBe("exit 2");

		expect(
			normalizeToolOperations(
				{ name: "bash", input: { command: "sleep 60" } },
				{ text: "[timed out after 5000ms]", status: "completed" },
			)[0]?.errorBadge,
		).toBe("timeout");

		expect(
			normalizeToolOperations({
				name: "str_replace_editor",
				input: { command: "view", path: "/Users/alice/app.ts" },
			})[0],
		).toMatchObject({
			verb: "read",
			target: "~/app.ts",
		});

		// OpenCode apply_patch (`patchText`), read (`offset`/`limit`), bash metadata error
		expect(
			normalizeToolOperations({
				name: "apply_patch",
				input: {
					patchText: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch",
				},
			}),
		).toEqual([
			{
				verb: "edit",
				rawName: "apply_patch",
				target: "old.ts",
				fullTarget: "old.ts",
				meta: "delete",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations({
				name: "read",
				input: { path: "/home/dev/src/index.ts", offset: 10, limit: 50 },
			}),
		).toEqual([
			{
				verb: "read",
				rawName: "read",
				target: "~/src/index.ts",
				fullTarget: "/home/dev/src/index.ts",
				meta: "#L10-60",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations(
				{ name: "bash", input: { command: "false" } },
				{ output: { output: "", metadata: { exit: 1 } }, status: "error" },
			)[0]?.errorBadge,
		).toBe("exit 1");

		// CommandCode shell_command + args
		expect(
			normalizeToolOperations({
				name: "shell_command",
				input: { command: "git", args: ["status", "-sb"] },
			}),
		).toMatchObject({
			0: {
				verb: "command",
				target: "git status -sb",
			},
		});

		// Antigravity client_view_file, invoke_subagent, call_mcp_tool, run_command exit text
		expect(
			normalizeToolOperations({
				name: "client_view_file",
				input: {
					absolute_path: "/Users/alice/project/main.ts",
					start_line: 1,
					end_line: 40,
				},
			}),
		).toEqual([
			{
				verb: "read",
				rawName: "client_view_file",
				target: "~/project/main.ts",
				fullTarget: "/Users/alice/project/main.ts",
				meta: "#L1-40",
				errorBadge: undefined,
			},
		]);

		expect(
			normalizeToolOperations({
				name: "invoke_subagent",
				input: { Subagents: [{ Role: "Code Reviewer", TypeName: "research" }] },
			})[0],
		).toMatchObject({
			verb: "subagent",
			target: "Code Reviewer",
		});

		expect(
			normalizeToolOperations({
				name: "call_mcp_tool",
				input: { ServerName: "t3-code", ToolName: "preview_open" },
			})[0],
		).toMatchObject({
			verb: "mcp",
			target: "t3-code · preview_open",
		});

		expect(
			extractErrorBadge("completed", undefined, "Command exited with code 127"),
		).toBe("exit 127");
	});

	test("pairs tool calls and results across IDs, multi-chunk outputs, ID-less steps, and orphans", () => {
		const items = [
			{ id: "c1", kind: "tool_call", turnId: "t1", toolCallId: "call-1" },
			{ id: "c2", kind: "tool_call", turnId: "t1", toolCallId: null },
			{ id: "r2", kind: "tool_result", turnId: "t1", toolCallId: null },
			{ id: "r1a", kind: "tool_result", turnId: "t1", toolCallId: "call-1" },
			{ id: "r1b", kind: "tool_result", turnId: "t1", toolCallId: "call-1" },
			{ id: "c3", kind: "tool_call", turnId: "t2", toolCallId: "call-3" },
			{ id: "r3", kind: "tool_result", turnId: "t2", toolCallId: null },
			{
				id: "orphan",
				kind: "tool_result",
				turnId: "t2",
				toolCallId: "missing",
			},
		];
		const pairs = pairToolItems(items);
		expect(pairs).toHaveLength(4);
		expect(pairs[0]?.results.map((r) => r.id)).toEqual(["r1a", "r1b"]);
		expect(pairs[1]?.results.map((r) => r.id)).toEqual(["r2"]);
		expect(pairs[2]?.results.map((r) => r.id)).toEqual(["r3"]);
		expect(pairs[3]?.call.id).toBe("orphan");
	});

	test("unwraps nested tool outputs cleanly", () => {
		expect(
			unwrapToolOutput({
				output: "hello",
				metadata: { exit_code: 3 },
			}),
		).toBe("hello\n[exit code: 3]");
		expect(
			unwrapToolOutput({
				error: { type: "PermissionDenied", message: "User rejected tool" },
			}),
		).toBe("User rejected tool");
		expect(
			unwrapToolOutput(
				[{ type: "input_text", text: "from array" }],
				"from array",
			),
		).toBe("from array");
	});

	test("handles balanced JS code-mode calls without cross-call bleed or quote truncation", () => {
		const multiCall = [
			'await tools.web__run({ open: [{ ref_id: "turn0search0", lineno: 1 }] });',
			"await tools.exec_command({ cmd: \"rg -n 'a|b' src/\" });",
			'await tools.mcp__context7__query_docs({ libraryId: "/recharts/recharts", query: "Tooltip" });',
		].join("\n");

		expect(
			normalizeToolOperations({ name: "exec", input: { code: multiCall } }),
		).toEqual([
			{
				verb: "openPage",
				rawName: "web__run",
				target: "turn0search0",
				fullTarget: "turn0search0",
				meta: undefined,
				errorBadge: undefined,
			},
			{
				verb: "command",
				rawName: "exec_command",
				target: "rg -n 'a|b' src/",
				fullTarget: "rg -n 'a|b' src/",
				meta: undefined,
				errorBadge: undefined,
			},
			{
				verb: "mcp",
				rawName: "mcp__context7__query_docs",
				target: "context7 · query_docs",
				meta: "Tooltip",
				errorBadge: undefined,
			},
		]);

		// OpenCode `execute` code-mode tool
		expect(
			normalizeToolOperations({
				name: "execute",
				input: {
					code: 'await tools.grep({ pattern: "dataKey", path: "/repo/app" }); await tools.read({ path: "/Users/alice/app/chart.tsx", offset: 1, limit: 20 });',
				},
			}),
		).toMatchObject([
			{ verb: "search", target: "dataKey", meta: "/repo/app" },
			{ verb: "read", target: "~/app/chart.tsx", meta: "#L1-21" },
		]);
	});

	test("normalizes skill, sleep, web__run, goal, question title, present, and zero-arg tools", () => {
		expect(
			normalizeToolOperations({
				name: "skill",
				input: { id: "jujutsu-vcs" },
			})[0],
		).toMatchObject({ verb: "skill", target: "jujutsu-vcs" });

		expect(
			normalizeToolOperations({
				name: "activate_skill",
				input: { name: "design", arguments: "compact layout" },
			})[0],
		).toMatchObject({
			verb: "skill",
			target: "design",
			meta: "compact layout",
		});

		expect(
			normalizeToolOperations({
				name: "sleep",
				input: { duration_ms: 30_000 },
			})[0],
		).toMatchObject({ verb: "command", target: "sleep 30s" });

		expect(
			normalizeToolOperations({
				name: "web__run",
				input: { search_query: [{ q: "recharts duplicate category" }] },
			})[0],
		).toMatchObject({
			verb: "webSearch",
			target: "recharts duplicate category",
		});

		expect(
			normalizeToolOperations({
				name: "request_user_input_async",
				input: { questions: [{ title: "Confirm deploy" }] },
			})[0],
		).toMatchObject({ verb: "question", target: "Confirm deploy" });

		expect(
			normalizeToolOperations({
				name: "create_goal",
				input: { objective: "Finish benchmark harness" },
			})[0],
		).toMatchObject({ verb: "plan", target: "Finish benchmark harness" });

		expect(
			normalizeToolOperations({
				name: "present",
				input: {
					files: [{ path: "/Users/alice/docs/report.md" }],
				},
			})[0],
		).toMatchObject({ verb: "other", target: "~/docs/report.md" });

		expect(
			normalizeToolOperations({ name: "enter_plan_mode", input: {} })[0],
		).toMatchObject({ verb: "plan", target: "enter_plan_mode" });
	});
});
