import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockOsEnvProvider } from "../../../src/platform/env";
import { DefaultPlatformPathService } from "../../../src/platform/paths";
import {
	DefaultHarnessRegistry,
	defaultHarnessRegistry,
	getAllHarnesses,
	getAllProviders,
	getAvailableHarnesses,
	getAvailableProviders,
	getDefaultHarnessRegistry,
	getHarness,
	getProvider,
	registerHarness,
	unregisterHarness,
} from "../../../src/providers/registry";
import type { HarnessProvider } from "../../../src/providers/types";

function createMockProvider(
	id: string,
	name = id,
	isAvail = true,
): HarnessProvider {
	return {
		metadata: {
			id,
			displayName: name,
			shortLabel: id.slice(0, 3).toUpperCase(),
			color: "#000000",
		},
		async isAvailable() {
			return isAvail;
		},
		async discoverSessions() {
			return [];
		},
		async readUsage() {
			return {
				harness: id,
				available: isAvail,
				records: [],
				warnings: [],
				messages: new Map(),
			};
		},
		async readTranscript() {
			return null;
		},
		async computeFingerprint() {
			return "v12:0:hash";
		},
		getWatchPaths() {
			return [];
		},
	};
}

describe("Providers: HarnessRegistry & Dynamic Registration (Feature 6)", () => {
	const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "ct-registry-test-"));
	const isolatedPaths = new DefaultPlatformPathService(
		new MockOsEnvProvider({ platform: "darwin", home: isolatedHome }),
	);

	afterAll(() => {
		defaultHarnessRegistry.reset();
		rmSync(isolatedHome, { recursive: true, force: true });
	});

	beforeEach(() => {
		defaultHarnessRegistry.reset();
	});

	// --- Tier 1: Happy-Path Operations ---

	test("F6-T1-01: DefaultHarnessRegistry pre-registers 15 harnesses", () => {
		const registry = new DefaultHarnessRegistry();
		const all = registry.getAll();
		const ids = all.map((p) => p.metadata.id).sort();

		expect(ids).toEqual(
			[
				"aider",
				"antigravity",
				"claude",
				"cline",
				"codex",
				"commandcode",
				"continue",
				"copilot",
				"cursor",
				"dsh",
				"goose",
				"opencode",
				"openhands",
				"roo",
				"windsurf",
			].sort(),
		);
		expect(registry.has("codex")).toBe(true);
		expect(registry.has("dsh")).toBe(true);
		expect(registry.has("opencode")).toBe(true);
		expect(registry.has("commandcode")).toBe(true);
		expect(registry.has("antigravity")).toBe(true);
		expect(registry.has("claude")).toBe(true);
		expect(registry.has("cline")).toBe(true);
		expect(registry.has("roo")).toBe(true);
		expect(registry.has("continue")).toBe(true);
		expect(registry.has("cursor")).toBe(true);
		expect(registry.has("copilot")).toBe(true);
		expect(registry.has("aider")).toBe(true);
		expect(registry.has("windsurf")).toBe(true);
		expect(registry.has("goose")).toBe(true);
		expect(registry.has("openhands")).toBe(true);
	});

	test("F6-T1-02: Case-insensitive provider lookup with get() and has()", () => {
		const registry = new DefaultHarnessRegistry();

		expect(registry.get("codex")?.metadata.displayName).toBe("Codex");
		expect(registry.get("CODEX")?.metadata.displayName).toBe("Codex");
		expect(registry.get("CoDeX")?.metadata.displayName).toBe("Codex");

		expect(registry.has("DSH")).toBe(true);
		expect(registry.has("dsh")).toBe(true);
		expect(registry.has("OpenCode")).toBe(true);
		expect(registry.has("OPENCODE")).toBe(true);

		expect(registry.get("unknown-harness")).toBeUndefined();
		expect(registry.has("unknown-harness")).toBe(false);
	});

	test("F6-T1-03: Dynamic registration of custom HarnessProvider", () => {
		const registry = new DefaultHarnessRegistry();
		const customProvider = createMockProvider("custom-tool", "Custom Tool");

		registry.register(customProvider);

		expect(registry.has("custom-tool")).toBe(true);
		expect(registry.has("CUSTOM-TOOL")).toBe(true);
		expect(registry.get("custom-tool")?.metadata.displayName).toBe(
			"Custom Tool",
		);
		expect(registry.getAll()).toHaveLength(16);
	});

	test("F6-T1-04: Provider unregistration returns true for existing and false for missing", () => {
		const registry = new DefaultHarnessRegistry();

		expect(registry.unregister("codex")).toBe(true);
		expect(registry.has("codex")).toBe(false);
		expect(registry.get("codex")).toBeUndefined();
		expect(registry.getAll()).toHaveLength(14);

		// Case-insensitive unregister
		expect(registry.unregister("DSH")).toBe(true);
		expect(registry.has("dsh")).toBe(false);

		// Non-existent unregister
		expect(registry.unregister("non-existent")).toBe(false);
	});

	test("F6-T1-05: clear() removes all providers and reset() restores defaults", () => {
		const registry = new DefaultHarnessRegistry();
		expect(registry.getAll().length).toBeGreaterThan(0);

		registry.clear();
		expect(registry.getAll()).toHaveLength(0);
		expect(registry.has("codex")).toBe(false);

		registry.reset();
		expect(registry.getAll()).toHaveLength(15);
		expect(registry.has("codex")).toBe(true);
		expect(registry.has("antigravity")).toBe(true);
	});

	test("F6-T1-06: getAvailable() filters providers by isAvailable() result", async () => {
		const registry = new DefaultHarnessRegistry();
		registry.clear();

		const activeProvider = createMockProvider("active", "Active", true);
		const inactiveProvider = createMockProvider("inactive", "Inactive", false);
		const throwingProvider: HarnessProvider = {
			...createMockProvider("throwing", "Throwing", false),
			async isAvailable() {
				throw new Error("Disk read failure");
			},
		};

		registry.register(activeProvider);
		registry.register(inactiveProvider);
		registry.register(throwingProvider);

		const available = await registry.getAvailable(isolatedPaths);
		expect(available).toHaveLength(1);
		expect(available[0]?.metadata.id).toBe("active");
	});

	test("F6-T1-07: Convenience helper functions operate on defaultHarnessRegistry", async () => {
		expect(getDefaultHarnessRegistry()).toBe(defaultHarnessRegistry);
		expect(getHarness("CODEX")?.metadata.displayName).toBe("Codex");
		expect(getProvider("CODEX")?.metadata.displayName).toBe("Codex");
		expect(getAllHarnesses()).toHaveLength(15);
		expect(getAllProviders()).toHaveLength(15);

		const custom = createMockProvider("helper-test", "Helper Test", true);
		registerHarness(custom);
		expect(getHarness("helper-test")?.metadata.displayName).toBe("Helper Test");
		expect(getProvider("helper-test")?.metadata.displayName).toBe(
			"Helper Test",
		);

		const available = await getAvailableHarnesses(isolatedPaths);
		expect(available.map((p) => p.metadata.id)).toEqual(["helper-test"]);
		const availableProv = await getAvailableProviders(isolatedPaths);
		expect(availableProv.length).toBe(available.length);

		expect(unregisterHarness("helper-test")).toBe(true);
		expect(getHarness("helper-test")).toBeUndefined();
	});

	test("F6-T1-08: Provider overwrite and replacement updates instance without duplicating", () => {
		const registry = new DefaultHarnessRegistry();
		const originalCount = registry.getAll().length;

		const providerV1 = createMockProvider("my-tool", "My Tool V1");
		const providerV2 = createMockProvider("MY-TOOL", "My Tool V2");

		registry.register(providerV1);
		expect(registry.getAll()).toHaveLength(originalCount + 1);
		expect(registry.get("my-tool")?.metadata.displayName).toBe("My Tool V1");

		// Register with uppercase ID replaces prior registration
		registry.register(providerV2);
		expect(registry.getAll()).toHaveLength(originalCount + 1);
		expect(registry.get("my-tool")?.metadata.displayName).toBe("My Tool V2");
	});

	// --- Tier 2: Boundary, Corruption & Error Handling ---

	test("F6-T2-01: Resilient error handling on faulty isAvailable() implementation", async () => {
		const registry = new DefaultHarnessRegistry();
		registry.clear();

		const crashingProvider: HarnessProvider = {
			...createMockProvider("crasher", "Crasher"),
			async isAvailable() {
				throw new TypeError(
					"Cannot read properties of undefined (reading 'access')",
				);
			},
		};

		const rejectingProvider: HarnessProvider = {
			...createMockProvider("rejecter", "Rejecter"),
			async isAvailable() {
				return Promise.reject(new Error("Timeout during disk I/O"));
			},
		};

		const healthyProvider = createMockProvider("healthy", "Healthy", true);

		registry.register(crashingProvider);
		registry.register(rejectingProvider);
		registry.register(healthyProvider);

		// Must not throw or crash unhandled
		const available = await registry.getAvailable(isolatedPaths);
		expect(available).toHaveLength(1);
		expect(available[0]?.metadata.id).toBe("healthy");
	});

	test("F6-T2-02: Abnormal and edge-case harness IDs", () => {
		const registry = new DefaultHarnessRegistry();

		// Empty string
		expect(registry.get("")).toBeUndefined();
		expect(registry.has("")).toBe(false);
		expect(registry.unregister("")).toBe(false);

		// Whitespace
		expect(registry.get("   ")).toBeUndefined();
		expect(registry.has("   ")).toBe(false);
		expect(registry.unregister("   ")).toBe(false);

		// Unicode & Emojis
		expect(registry.get("🤖")).toBeUndefined();
		expect(registry.has("🤖")).toBe(false);

		// Special regex metacharacters
		expect(registry.get(".*+?^\x24{}()|[]\\")).toBeUndefined();
		expect(registry.has(".*+?^\x24{}()|[]\\")).toBe(false);

		// Extremely long string
		const longId = "a".repeat(1000);
		expect(registry.get(longId)).toBeUndefined();
		expect(registry.has(longId)).toBe(false);
	});

	test("F6-T2-03: Concurrent mutation during availability sweep", async () => {
		const registry = new DefaultHarnessRegistry();
		registry.clear();

		let resolveSlow: (v: boolean) => void = () => {};
		const slowPromise = new Promise<boolean>((resolve) => {
			resolveSlow = resolve;
		});

		const slowProvider: HarnessProvider = {
			...createMockProvider("slow", "Slow Provider"),
			async isAvailable() {
				return slowPromise;
			},
		};

		const fastProvider = createMockProvider("fast", "Fast Provider", true);

		registry.register(slowProvider);
		registry.register(fastProvider);

		// Start availability check
		const availPromise = registry.getAvailable(isolatedPaths);

		// Concurrently mutate registry during the wait
		registry.register(createMockProvider("concurrent-1", "Concurrent 1", true));
		registry.unregister("fast");

		// Resolve slow provider
		resolveSlow(true);
		const available = await availPromise;

		// The snapshot processed should resolve without corruption
		expect(Array.isArray(available)).toBe(true);
		expect(available.some((p) => p.metadata.id === "slow")).toBe(true);
	});

	test("F6-T2-04: Reset isolation restores original 5 builtins after arbitrary mutations", () => {
		const registry = new DefaultHarnessRegistry();

		// Mutate: unregister 3 builtins, register 3 custom
		registry.unregister("codex");
		registry.unregister("dsh");
		registry.unregister("antigravity");
		registry.register(createMockProvider("tool-a"));
		registry.register(createMockProvider("tool-b"));
		registry.register(createMockProvider("tool-c"));

		expect(registry.has("codex")).toBe(false);
		expect(registry.has("tool-a")).toBe(true);

		// Reset
		registry.reset();

		expect(registry.getAll()).toHaveLength(15);
		const ids = registry
			.getAll()
			.map((p) => p.metadata.id)
			.sort();
		expect(ids).toEqual(
			[
				"aider",
				"antigravity",
				"claude",
				"cline",
				"codex",
				"commandcode",
				"continue",
				"copilot",
				"cursor",
				"dsh",
				"goose",
				"opencode",
				"openhands",
				"roo",
				"windsurf",
			].sort(),
		);
		expect(registry.has("tool-a")).toBe(false);
		expect(registry.has("tool-b")).toBe(false);
		expect(registry.has("tool-c")).toBe(false);
	});

	test("F6-T2-05: Complete registry purge via clear() leaves no residual state", async () => {
		const registry = new DefaultHarnessRegistry();
		registry.register(createMockProvider("extra-1"));
		registry.register(createMockProvider("extra-2"));

		registry.clear();

		expect(registry.getAll()).toHaveLength(0);
		expect(registry.get("codex")).toBeUndefined();
		expect(registry.get("extra-1")).toBeUndefined();
		expect(registry.has("dsh")).toBe(false);
		expect(await registry.getAvailable(isolatedPaths)).toEqual([]);
	});

	test("F6-T2-06: Multiple instances of DefaultHarnessRegistry remain isolated", () => {
		const regA = new DefaultHarnessRegistry();
		const regB = new DefaultHarnessRegistry();

		regA.register(createMockProvider("unique-to-a"));
		expect(regA.has("unique-to-a")).toBe(true);
		expect(regB.has("unique-to-a")).toBe(false);

		regB.clear();
		expect(regB.getAll()).toHaveLength(0);
		expect(regA.getAll().length).toBeGreaterThan(0);
	});
});
