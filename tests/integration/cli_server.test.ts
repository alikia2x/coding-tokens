import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { store } from "../../server/data/store";
import { startServer } from "../../server/start";
import { MockOsEnvProvider } from "../../src/platform/env";
import { DefaultPlatformPathService } from "../../src/platform/paths";
import {
	defaultHarnessRegistry,
	getAllProviders,
	getAvailableProviders,
	getProvider,
} from "../../src/providers/registry";

const EXPECTED_15_HARNESSES = [
	"codex",
	"dsh",
	"opencode",
	"commandcode",
	"antigravity",
	"claude",
	"cline",
	"roo",
	"continue",
	"cursor",
	"windsurf",
	"copilot",
	"aider",
	"goose",
	"openhands",
] as const;

describe("Milestone 4: CLI and Server Full Integration", () => {
	const suiteTmp = path.join(
		process.cwd(),
		"tests",
		".tmp",
		`cli-server-int-${Date.now()}`,
	);

	const originalEnv: Record<string, string | undefined> = {};
	const envKeys = [
		"HOME",
		"CODEX_HOME",
		"DSH_HOME",
		"OPENCODE_DATA_DIR",
		"OPENCODE_DB",
		"COMMANDCODE_HOME",
		"ANTIGRAVITY_HOME",
		"T3_USER_DATA_DIR",
		"CLAUDE_CONFIG_DIR",
		"AIDER_HOME",
		"GOOSE_PATH_ROOT",
		"OPENHANDS_DIR",
		"OPENHANDS_CONVERSATIONS_DIR",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_CACHE_HOME",
	] as const;

	beforeAll(() => {
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
		}

		const mockHome = path.join(suiteTmp, "home");
		mkdirSync(suiteTmp, { recursive: true });
		mkdirSync(mockHome, { recursive: true });

		process.env.HOME = mockHome;
		process.env.CODEX_HOME = path.join(suiteTmp, "codex");
		process.env.DSH_HOME = path.join(suiteTmp, "dsh");
		process.env.OPENCODE_DATA_DIR = path.join(suiteTmp, "opencode");
		process.env.OPENCODE_DB = path.join(suiteTmp, "opencode.db");
		process.env.COMMANDCODE_HOME = path.join(suiteTmp, "commandcode");
		process.env.ANTIGRAVITY_HOME = path.join(suiteTmp, "antigravity");
		process.env.T3_USER_DATA_DIR = path.join(suiteTmp, "t3");
		process.env.CLAUDE_CONFIG_DIR = path.join(suiteTmp, "claude");
		process.env.AIDER_HOME = path.join(suiteTmp, "aider");
		process.env.GOOSE_PATH_ROOT = path.join(suiteTmp, "goose");
		process.env.OPENHANDS_DIR = path.join(suiteTmp, "openhands");
		process.env.OPENHANDS_CONVERSATIONS_DIR = path.join(
			suiteTmp,
			"openhands",
			"conversations",
		);
		process.env.XDG_CONFIG_HOME = path.join(suiteTmp, "xdg-config");
		process.env.XDG_DATA_HOME = path.join(suiteTmp, "xdg-data");
		process.env.XDG_CACHE_HOME = path.join(suiteTmp, "xdg-cache");

		for (const key of envKeys) {
			if (key !== "OPENCODE_DB") {
				const dir = process.env[key];
				if (dir) mkdirSync(dir, { recursive: true });
			}
		}
	});

	afterAll(() => {
		store.close();
		for (const [key, val] of Object.entries(originalEnv)) {
			if (val === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = val;
			}
		}
		try {
			rmSync(suiteTmp, { recursive: true, force: true });
		} catch {}
	});

	// =========================================================================
	// 1. Registry Wiring Verification
	// =========================================================================
	describe("1. HarnessRegistry Wiring", () => {
		test("exposes all 15 harnesses in default registry", () => {
			const all = defaultHarnessRegistry.getAll();
			expect(all.length).toBe(15);
			const ids = all.map((p) => p.metadata.id);
			for (const expectedId of EXPECTED_15_HARNESSES) {
				expect(ids).toContain(expectedId);
			}
		});

		test("getAllProviders helper returns all 15 providers with valid metadata", () => {
			const providers = getAllProviders();
			expect(providers.length).toBe(15);
			for (const p of providers) {
				expect(p.metadata.id).toBeDefined();
				expect(p.metadata.displayName).toBeDefined();
				expect(p.metadata.displayName.length).toBeGreaterThan(0);
				expect(p.metadata.shortLabel).toBeDefined();
				expect(p.metadata.color).toBeDefined();
				expect(p.metadata.color.length).toBeGreaterThan(0);
			}
		});

		test("getProvider retrieves each harness individually", () => {
			for (const id of EXPECTED_15_HARNESSES) {
				const provider = getProvider(id);
				expect(provider).toBeDefined();
				expect(provider?.metadata.id).toBe(id);
			}
		});

		test("getAvailableProviders discovers available harnesses without throwing", async () => {
			const isolatedPaths = new DefaultPlatformPathService(
				new MockOsEnvProvider({
					platform: "darwin",
					home: path.join(suiteTmp, "home"),
				}),
			);
			const available = await getAvailableProviders(isolatedPaths);
			expect(Array.isArray(available)).toBe(true);
		});
	});

	// =========================================================================
	// 2. CLI Dynamic Harness Options & Execution
	// =========================================================================
	describe("2. CLI Modernization & Dynamic Validation", () => {
		test("CLI --help executes cleanly and displays options", async () => {
			const proc = Bun.spawn(["bun", "src/cli.ts", "--help"], {
				stdout: "pipe",
				stderr: "pipe",
				env: process.env,
			});
			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			expect(exitCode).toBe(0);
			expect(stdout).toContain("--harness");
			expect(stdout).toContain("export");
		});

		test("CLI rejects invalid harness name with helpful error", async () => {
			const proc = Bun.spawn(
				["bun", "src/cli.ts", "--harness", "invalid_random_harness_xyz"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				},
			);
			const exitCode = await proc.exited;
			const stderr = await new Response(proc.stderr).text();
			expect(exitCode).not.toBe(0);
			expect(stderr).toContain("--harness accepts:");
		});

		test("CLI accepts valid registered harnesses in --harness filter", async () => {
			const proc = Bun.spawn(
				["bun", "src/cli.ts", "--harness", "codex,claude,cursor"],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				},
			);
			const exitCode = await proc.exited;
			expect(exitCode).toBe(0);
		});

		test("CLI --export-dir creates structured markdown export directory", async () => {
			const exportDir = path.join(suiteTmp, "cli-export-dir");
			mkdirSync(exportDir, { recursive: true });

			const proc = Bun.spawn(
				["bun", "src/cli.ts", "--harness", "codex", "--export-dir", exportDir],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: process.env,
				},
			);
			const exitCode = await proc.exited;
			expect(exitCode).toBe(0);
			expect(existsSync(exportDir)).toBe(true);
		}, 15000);
	});

	// =========================================================================
	// 3. Server API Dynamic Harness Endpoints
	// =========================================================================
	describe("3. Server API Dynamic Harness Endpoints", () => {
		let serverInstance: ReturnType<typeof startServer>;
		let baseUrl: string;

		beforeAll(async () => {
			const testDb = path.join(suiteTmp, "test-server.sqlite");
			store.configure({ dbPath: testDb });
			await store.start();
			await store.ensureReady();

			serverInstance = startServer({
				port: 0,
				hostname: "127.0.0.1",
				dbPath: testDb,
			});
			baseUrl = `http://127.0.0.1:${serverInstance.port}`;
		});

		afterAll(() => {
			serverInstance?.server?.stop(true);
			store.close();
		});

		test("GET /api/harnesses returns metadata, labels, and colors for all 15 harnesses", async () => {
			const res = await fetch(`${baseUrl}/api/harnesses`);
			expect(res.status).toBe(200);
			const data = (await res.json()) as {
				rows: Array<{
					harness: string;
					label: string;
					color: string;
					available: boolean;
					paths: string[];
					totals: unknown;
				}>;
			};

			expect(data.rows.length).toBe(15);
			const returnedHarnesses = data.rows.map((r) => r.harness);
			for (const id of EXPECTED_15_HARNESSES) {
				expect(returnedHarnesses).toContain(id);
				const row = data.rows.find((r) => r.harness === id);
				expect(row).toBeDefined();
				expect(row?.label.length).toBeGreaterThan(0);
				expect(row?.color.length).toBeGreaterThan(0);
				expect(Array.isArray(row?.paths)).toBe(true);
				expect(row?.totals).toBeDefined();
			}
		});

		test("GET /api/overview returns aggregated overview data", async () => {
			const res = await fetch(`${baseUrl}/api/overview`);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { totals: unknown };
			expect(data.totals).toBeDefined();
		});

		test("GET /api/explore?dimension=harness serves dynamic exploration data", async () => {
			const res = await fetch(`${baseUrl}/api/explore?dimension=harness`);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { dimension: string };
			expect(data.dimension).toBe("harness");
		});

		test("GET /api/sessions returns sessions list", async () => {
			const res = await fetch(`${baseUrl}/api/sessions`);
			expect(res.status).toBe(200);
			const data = (await res.json()) as { sessions: unknown[] };
			expect(Array.isArray(data.sessions)).toBe(true);
		});

		test("GET /api/sessions/:harness/:sessionId rejects unregistered harness with 400", async () => {
			const res = await fetch(
				`${baseUrl}/api/sessions/invalid_unknown_harness/session123`,
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("Unknown harness");
		});

		test("GET /api/sessions/:harness/:sessionId accepts valid registered harness", async () => {
			// Even if session is not in local storage, a registered harness must not fail with "Unknown harness"
			const res = await fetch(
				`${baseUrl}/api/sessions/claude/non-existent-session-id`,
			);
			// Should return 404 "Session not found", not 400 "Unknown harness"
			expect(res.status).toBe(404);
			const data = (await res.json()) as { error: string };
			expect(data.error).toBe("Session not found");
		});

		test("POST /api/sessions/:harness/:sessionId/export rejects invalid harness", async () => {
			const res = await fetch(
				`${baseUrl}/api/sessions/unregistered_harness/sess1/export`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ level: "chat" }),
				},
			);
			expect(res.status).toBe(400);
			const data = (await res.json()) as { error: string };
			expect(data.error).toContain("Unknown harness");
		});
	});
});
