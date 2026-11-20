import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

describe("CLI Integration Suite (Feature 1)", () => {
	const suiteTmp = path.join(
		os.tmpdir(),
		`ct-cli-suite-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	const mockHome = path.join(suiteTmp, "home");
	const codexHome = path.join(suiteTmp, "codex");
	const dshHome = path.join(suiteTmp, "dsh");
	const opencodeData = path.join(suiteTmp, "opencode");
	const opencodeDb = path.join(suiteTmp, "opencode.db");
	const commandcodeHome = path.join(suiteTmp, "commandcode");
	const antigravityHome = path.join(suiteTmp, "antigravity");
	const t3UserData = path.join(suiteTmp, "t3");
	const claudeConfigDir = path.join(suiteTmp, "claude");
	const aiderHome = path.join(suiteTmp, "aider");
	const gooseRoot = path.join(suiteTmp, "goose");
	const openhandsDir = path.join(suiteTmp, "openhands");
	const xdgConfigHome = path.join(suiteTmp, "xdg-config");
	const xdgDataHome = path.join(suiteTmp, "xdg-data");
	const xdgCacheHome = path.join(suiteTmp, "xdg-cache");

	const isolatedEnv: Record<string, string> = {
		HOME: mockHome,
		CODEX_HOME: codexHome,
		DSH_HOME: dshHome,
		OPENCODE_DATA_DIR: opencodeData,
		OPENCODE_DB: opencodeDb,
		COMMANDCODE_HOME: commandcodeHome,
		ANTIGRAVITY_HOME: antigravityHome,
		T3_USER_DATA_DIR: t3UserData,
		CLAUDE_CONFIG_DIR: claudeConfigDir,
		AIDER_HOME: aiderHome,
		GOOSE_PATH_ROOT: gooseRoot,
		OPENHANDS_DIR: openhandsDir,
		OPENHANDS_CONVERSATIONS_DIR: path.join(openhandsDir, "conversations"),
		XDG_CONFIG_HOME: xdgConfigHome,
		XDG_DATA_HOME: xdgDataHome,
		XDG_CACHE_HOME: xdgCacheHome,
	};

	beforeAll(() => {
		mkdirSync(suiteTmp, { recursive: true });
		mkdirSync(mockHome, { recursive: true });
		mkdirSync(codexHome, { recursive: true });
		mkdirSync(dshHome, { recursive: true });
		mkdirSync(opencodeData, { recursive: true });
		mkdirSync(commandcodeHome, { recursive: true });
		mkdirSync(antigravityHome, { recursive: true });
		mkdirSync(t3UserData, { recursive: true });
		mkdirSync(claudeConfigDir, { recursive: true });
		mkdirSync(aiderHome, { recursive: true });
		mkdirSync(gooseRoot, { recursive: true });
		mkdirSync(openhandsDir, { recursive: true });
		mkdirSync(xdgConfigHome, { recursive: true });
		mkdirSync(xdgDataHome, { recursive: true });
		mkdirSync(xdgCacheHome, { recursive: true });

		// Seed a minimal valid Codex session so that export commands find sessions
		const codexSessionsDir = path.join(codexHome, "sessions");
		mkdirSync(codexSessionsDir, { recursive: true });
		const sampleSessionFile = path.join(
			codexSessionsDir,
			"rollout-2026-03-15T10-00-00-codex-sess-1.jsonl",
		);
		const lines = [
			JSON.stringify({
				type: "session_meta",
				timestamp: "2026-03-15T10:00:00.000Z",
				payload: {
					id: "codex-sess-1",
					timestamp: "2026-03-15T10:00:00.000Z",
					cwd: "/workspace/sample-project",
				},
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-03-15T10:00:01.000Z",
				payload: {
					type: "message",
					role: "user",
					content: [{ type: "text", text: "Explain binary search." }],
				},
			}),
			JSON.stringify({
				type: "response_item",
				timestamp: "2026-03-15T10:00:02.000Z",
				payload: {
					type: "message",
					role: "assistant",
					content: [
						{ type: "text", text: "Binary search divides the array in half." },
					],
				},
			}),
			JSON.stringify({
				type: "token_usage_record",
				timestamp: "2026-03-15T10:00:03.000Z",
				payload: {
					usage: {
						input_tokens: 150,
						output_tokens: 45,
						cached_input_tokens: 20,
						reasoning_output_tokens: 5,
					},
				},
			}),
		];
		writeFileSync(sampleSessionFile, lines.join("\n"), "utf8");
	});

	afterAll(() => {
		try {
			rmSync(suiteTmp, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	async function execCli(
		args: string[],
		customEnv: Record<string, string> = {},
	) {
		const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
			cwd: process.cwd(),
			env: {
				...process.env,
				...isolatedEnv,
				...customEnv,
			},
			stdout: "pipe",
			stderr: "pipe",
		});

		const exitCode = await proc.exited;
		const stdout = await new Response(proc.stdout).text();
		const stderr = await new Response(proc.stderr).text();
		return { exitCode, stdout, stderr };
	}

	// =========================================================================
	// Tier 1: Happy-Path Operations (10 tests)
	// =========================================================================
	describe("Tier 1: Happy Path", () => {
		test("CLI-T1-01: --help and -h flags display usage and exit 0", async () => {
			const resLong = await execCli(["--help"]);
			expect(resLong.exitCode).toBe(0);
			expect(resLong.stdout).toContain("Usage: bun run src/cli.ts [options]");
			expect(resLong.stdout).toContain("--by <fields>");
			expect(resLong.stdout).toContain("--harness <names>");
			expect(resLong.stdout).toContain("--export-dir <path>");

			const resShort = await execCli(["-h"]);
			expect(resShort.exitCode).toBe(0);
			expect(resShort.stdout).toContain("Usage: bun run src/cli.ts [options]");
		});

		test("CLI-T1-02: --format json returns valid JSON report schema", async () => {
			const res = await execCli(["--format", "json"]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed).toHaveProperty("groupBy");
			expect(parsed.groupBy).toEqual(["harness", "project", "model"]);
			expect(parsed).toHaveProperty("filters");
			expect(parsed.filters).toHaveProperty("harnesses");
			expect(parsed).toHaveProperty("totals");
			expect(parsed).toHaveProperty("groups");
			expect(Array.isArray(parsed.groups)).toBe(true);
		});

		test("CLI-T1-03: Default format is table with standard column headers", async () => {
			const res = await execCli([]);
			expect(res.exitCode).toBe(0);
			// Either table output or "No usage records found."
			// When records exist from codex fixture:
			expect(
				res.stdout.includes("Harness") ||
					res.stdout.includes("No usage records found."),
			).toBe(true);
		});

		test("CLI-T1-04: --harness filters to specified harnesses", async () => {
			const res = await execCli(["--format", "json", "--harness", "codex,dsh"]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed.filters.harnesses).toEqual(["codex", "dsh"]);
			for (const group of parsed.groups) {
				expect(["codex", "dsh"]).toContain(group.values.harness);
			}
		});

		test("CLI-T1-05: --by model groups strictly by model", async () => {
			const res = await execCli(["--format", "json", "--by", "model"]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed.groupBy).toEqual(["model"]);
			for (const group of parsed.groups) {
				expect(Object.keys(group.values)).toEqual(["model"]);
			}
		});

		test("CLI-T1-06: --project filter resolves absolute paths", async () => {
			const testProject = "/workspace/sample-project";
			const res = await execCli(["--format", "json", "--project", testProject]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed.filters.projects).toEqual([path.resolve(testProject)]);
		});

		test("CLI-T1-07: --since and --until date range filtering", async () => {
			const res = await execCli([
				"--format",
				"json",
				"--since",
				"2026-03-01",
				"--until",
				"2026-03-15",
			]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed.filters.since).toBe("2026-03-01");
			expect(parsed.filters.until).toBe("2026-03-15");
		});

		test("CLI-T1-08: Datetime with explicit hours, minutes and seconds", async () => {
			const res = await execCli([
				"--format",
				"json",
				"--since",
				"2026-03-01 09:30:00",
				"--until",
				"2026-03-15 18:00:00",
			]);
			expect(res.exitCode).toBe(0);
			const parsed = JSON.parse(res.stdout);
			expect(parsed.filters.since).toBe("2026-03-01 09:30:00");
			expect(parsed.filters.until).toBe("2026-03-15 18:00:00");
		});

		function findMdFiles(dir: string): string[] {
			let results: string[] = [];
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					results = results.concat(findMdFiles(full));
				} else if (entry.isFile() && entry.name.endsWith(".md")) {
					results.push(full);
				}
			}
			return results;
		}

		test("CLI-T1-09: --export-dir exports markdown session files", async () => {
			const exportDir = path.join(suiteTmp, "exports-t1-09");
			mkdirSync(exportDir, { recursive: true });

			const res = await execCli([
				"--export-dir",
				exportDir,
				"--detail",
				"chat_compact",
			]);
			expect(res.exitCode).toBe(0);
			expect(res.stdout).toContain("Exported");

			const allMd = findMdFiles(exportDir);
			expect(allMd.length).toBeGreaterThan(0);
			const sessionMd = allMd.find((f) => f.includes("codex-sess-1"));
			expect(sessionMd).toBeDefined();
			if (!sessionMd) throw new Error("sessionMd not found");
			const mdContent = readFileSync(sessionMd, "utf8");
			expect(mdContent).toContain("Explain binary search.");
		});

		test("CLI-T1-10: --export-dir with --include-token-stats and --include-timestamps", async () => {
			const exportDir = path.join(suiteTmp, "exports-t1-10");
			mkdirSync(exportDir, { recursive: true });

			const res = await execCli([
				"--export-dir",
				exportDir,
				"--include-token-stats",
				"--include-timestamps",
			]);
			expect(res.exitCode).toBe(0);

			const allMd = findMdFiles(exportDir);
			const sessionMd = allMd.find((f) => f.includes("codex-sess-1"));
			expect(sessionMd).toBeDefined();
			if (!sessionMd) throw new Error("sessionMd not found");
			const mdContent = readFileSync(sessionMd, "utf8");
			expect(mdContent).toContain("[TOKENS]");
			expect(mdContent).toContain("input 130");
		});
	});

	// =========================================================================
	// Tier 2: Boundary, Corruption & Error Exit Codes (7 tests)
	// =========================================================================
	describe("Tier 2: Error Handling & Boundary Conditions", () => {
		test("CLI-T2-01: Invalid format flag exits 2 with error message", async () => {
			const res = await execCli(["--format", "xml"]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain("--format accepts table or json");
		});

		test("CLI-T2-02: Conflicting --date with --since or --until exits 2", async () => {
			const res = await execCli([
				"--date",
				"2026-03-01",
				"--since",
				"2026-03-01",
			]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain(
				"--date cannot be combined with --since or --until",
			);
		});

		test("CLI-T2-03: Inverted time range (--since > --until) exits 2", async () => {
			const res = await execCli([
				"--since",
				"2026-03-15",
				"--until",
				"2026-03-01",
			]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain("--since must be earlier than --until");
		});

		test("CLI-T2-04: Invalid calendar date exits 2", async () => {
			const res = await execCli(["--date", "2026-02-31"]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain("--date must be a valid YYYY-MM-DD date");
		});

		test("CLI-T2-05: Combining --export-dir with --format exits 2", async () => {
			const res = await execCli(["--export-dir", suiteTmp, "--format", "json"]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain(
				"--format cannot be combined with --export-dir",
			);
		});

		test("CLI-T2-06: --detail specified without --export-dir exits 2", async () => {
			const res = await execCli(["--detail", "chat"]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain("--detail requires --export-dir");
		});

		test("CLI-T2-07: Unknown harness name exits 2 with allowed harnesses", async () => {
			const res = await execCli(["--harness", "nonexistent_harness"]);
			expect(res.exitCode).toBe(2);
			expect(res.stderr).toContain(
				"--harness accepts: codex, dsh, opencode, commandcode, antigravity",
			);
		});
	});
});
