import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { MockOsEnvProvider } from "../../../src/platform/env";
import {
	DefaultPlatformPathService,
	defaultPlatformPathService,
} from "../../../src/platform/paths";
import {
	createMockEnv,
	withSandboxEnvironment,
} from "../../fixtures/helpers/mock-env";

describe("Platform: PlatformPathService (Feature 1)", () => {
	// =========================================================================
	// Tier 1: Happy Path Tests
	// =========================================================================

	test("F1-T1-01: Darwin platform directory resolution", () => {
		const env = createMockEnv("darwin", "/mock-base");
		const svc = new DefaultPlatformPathService(env);

		expect(svc.getConfigDir("app")).toBe(
			"/mock-base/Users/testuser/Library/Application Support/app",
		);
		expect(svc.getDataDir("app")).toBe(
			"/mock-base/Users/testuser/Library/Application Support/app",
		);
		expect(svc.getCacheDir("app")).toBe(
			"/mock-base/Users/testuser/Library/Caches/app",
		);
	});

	test("F1-T1-02: Linux default XDG directory resolution without overrides", () => {
		const env = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/testuser",
		});
		const svc = new DefaultPlatformPathService(env);

		expect(svc.getConfigDir("app")).toBe("/home/testuser/.config/app");
		expect(svc.getDataDir("app")).toBe("/home/testuser/.local/share/app");
		expect(svc.getCacheDir("app")).toBe("/home/testuser/.cache/app");
	});

	test("F1-T1-03: Linux custom XDG environment variable overrides", () => {
		const env = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/testuser",
			env: {
				XDG_CONFIG_HOME: "/custom/xdg/config",
				XDG_DATA_HOME: "/custom/xdg/data",
				XDG_CACHE_HOME: "/custom/xdg/cache",
			},
		});
		const svc = new DefaultPlatformPathService(env);

		expect(svc.getConfigDir("app")).toBe("/custom/xdg/config/app");
		expect(svc.getDataDir("app")).toBe("/custom/xdg/data/app");
		expect(svc.getCacheDir("app")).toBe("/custom/xdg/cache/app");
	});

	test("F1-T1-04: Windows Roaming and Local AppData resolution", () => {
		const env = createMockEnv("win32", "C:/mock-base");
		const svc = new DefaultPlatformPathService(env);

		expect(svc.getConfigDir("app")).toBe(
			"C:/mock-base/Users/testuser/AppData/Roaming/app",
		);
		expect(svc.getDataDir("app")).toBe(
			"C:/mock-base/Users/testuser/AppData/Local/app",
		);
		expect(svc.getCacheDir("app")).toBe(
			"C:/mock-base/Users/testuser/AppData/Local/app/cache",
		);
	});

	test("F1-T1-05: 15-Harness path resolution across OS platforms", () => {
		const harnesses = [
			"codex",
			"dsh",
			"opencode",
			"commandcode",
			"antigravity",
			"claude",
			"aider",
			"cline",
			"roo",
			"continue",
			"cursor",
			"copilot",
			"windsurf",
			"goose",
			"openhands",
		] as const;

		const platforms = ["darwin", "linux", "win32"] as const;

		for (const platform of platforms) {
			const env = createMockEnv(
				platform,
				platform === "win32" ? "C:/base" : "/base",
			);
			const svc = new DefaultPlatformPathService(env);

			for (const harness of harnesses) {
				const paths = svc.resolveHarnessPaths(harness);
				expect(paths.length).toBeGreaterThan(0);
				for (const p of paths) {
					expect(typeof p).toBe("string");
					expect(p.length).toBeGreaterThan(0);
					// Should be normalized forward-slash paths
					expect(p).not.toContain("\\");
				}
			}
		}
	});

	test("F1-T1-06: Sandbox directory resolution with withSandboxEnvironment", async () => {
		await withSandboxEnvironment("darwin", (sandbox) => {
			const svc = new DefaultPlatformPathService(sandbox.provider);
			const configDir = svc.getConfigDir("coding-tokens");
			expect(configDir.startsWith(sandbox.rootDir)).toBe(true);
			expect(existsSync(sandbox.homeDir)).toBe(true);
		});
	});

	// =========================================================================
	// Tier 2: Boundary & Corner Cases
	// =========================================================================

	test("F1-T2-01: Missing OS environment variables fallback", () => {
		// Windows with completely missing APPDATA and LOCALAPPDATA
		const winEnv = new MockOsEnvProvider({
			platform: "win32",
			home: "C:/Users/fallback",
			env: {},
		});
		const winSvc = new DefaultPlatformPathService(winEnv);
		expect(winSvc.getConfigDir("app")).toBe(
			"C:/Users/fallback/AppData/Roaming/app",
		);
		expect(winSvc.getDataDir("app")).toBe(
			"C:/Users/fallback/AppData/Local/app",
		);
		expect(winSvc.getCacheDir("app")).toBe(
			"C:/Users/fallback/AppData/Local/app/cache",
		);

		// Linux with completely empty env (no XDG variables)
		const linuxEnv = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/fallback",
			env: {},
		});
		const linuxSvc = new DefaultPlatformPathService(linuxEnv);
		expect(linuxSvc.getConfigDir("app")).toBe("/home/fallback/.config/app");
		expect(linuxSvc.getDataDir("app")).toBe("/home/fallback/.local/share/app");
		expect(linuxSvc.getCacheDir("app")).toBe("/home/fallback/.cache/app");
	});

	test("F1-T2-02: Windows case-insensitive environment lookup", () => {
		const winEnv = new MockOsEnvProvider({
			platform: "win32",
			home: "C:/Users/charlie",
			env: {
				appdata: "C:/Users/charlie/AppData/Roaming",
				LOCALAPPDATA: "C:/Users/charlie/AppData/Local",
			},
		});

		expect(winEnv.get("APPDATA")).toBe("C:/Users/charlie/AppData/Roaming");
		expect(winEnv.get("AppData")).toBe("C:/Users/charlie/AppData/Roaming");
		expect(winEnv.get("localappdata")).toBe("C:/Users/charlie/AppData/Local");

		const svc = new DefaultPlatformPathService(winEnv);
		expect(svc.getConfigDir("app")).toBe(
			"C:/Users/charlie/AppData/Roaming/app",
		);
		expect(svc.getDataDir("app")).toBe("C:/Users/charlie/AppData/Local/app");
	});

	test("F1-T2-03: Trailing / duplicate separators in base paths", () => {
		const env = new MockOsEnvProvider({
			platform: "linux",
			home: "/home/user///",
			env: {
				XDG_CONFIG_HOME: "/custom/xdg///config///",
			},
		});
		const svc = new DefaultPlatformPathService(env);
		expect(svc.getConfigDir("app")).toBe("/custom/xdg/config/app");
		expect(svc.getDataDir("app")).toBe("/home/user/.local/share/app");
	});

	test("F1-T2-04: Unknown harness ID resolution returns empty array", () => {
		const svc = new DefaultPlatformPathService();
		expect(svc.resolveHarnessPaths("unknown-tool-xyz")).toEqual([]);
		expect(svc.resolveHarnessPaths("")).toEqual([]);
	});

	test("F1-T2-05: Harness environment variable precedence", () => {
		const env = new MockOsEnvProvider({
			platform: "darwin",
			home: "/Users/alice",
			env: {
				CODEX_HOME: "~/my-codex",
				DSH_HOME: "/custom/dsh-location",
				CLAUDE_CONFIG_DIR: "~/.custom-claude",
				AIDER_HOME: "~/my-aider",
				COMMANDCODE_HOME: "/custom/commandcode",
				ANTIGRAVITY_HOME: "/custom/antigravity",
			},
		});
		const svc = new DefaultPlatformPathService(env);

		expect(svc.resolveHarnessPaths("codex")).toEqual([
			"/Users/alice/my-codex",
			"/Users/alice/my-codex/sessions",
			"/Users/alice/my-codex/archived_sessions",
		]);
		expect(svc.resolveHarnessPaths("dsh")).toEqual(["/custom/dsh-location"]);
		expect(svc.resolveHarnessPaths("claude")).toEqual([
			"/Users/alice/.custom-claude",
		]);
		expect(svc.resolveHarnessPaths("aider")).toEqual([
			"/Users/alice/my-aider",
			"/Users/alice/.aider.conf.yml",
		]);
		expect(svc.resolveHarnessPaths("commandcode")).toEqual([
			"/custom/commandcode",
			"/custom/commandcode/projects",
		]);
		expect(svc.resolveHarnessPaths("antigravity")).toEqual([
			"/custom/antigravity",
		]);
	});

	test("F1-T2-06: Default app name fallback defaults to coding-tokens", () => {
		const env = createMockEnv("darwin", "/base");
		const svc = new DefaultPlatformPathService(env);

		expect(svc.getConfigDir()).toBe(
			"/base/Users/testuser/Library/Application Support/coding-tokens",
		);
		expect(svc.getDataDir()).toBe(
			"/base/Users/testuser/Library/Application Support/coding-tokens",
		);
		expect(svc.getCacheDir()).toBe(
			"/base/Users/testuser/Library/Caches/coding-tokens",
		);
		expect(defaultPlatformPathService.getHomeDir().length).toBeGreaterThan(0);
	});
});
