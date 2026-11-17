import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultPlatformPathService } from "../../src/platform/paths";
import {
	getAllProviders,
	getAvailableProviders,
	getProvider,
} from "../../src/providers/registry";
import type { HarnessId } from "../../src/types";

const ALL_15_HARNESS_IDS: HarnessId[] = [
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
];

const KNOWN_HOST_HARNESSES_WITH_SESSIONS = [
	"codex",
	"dsh",
	"opencode",
	"commandcode",
	"antigravity",
	"claude",
	"cline",
	"continue",
];

describe.skipIf(Boolean(process.env.CI))(
	"Feature 25: Real Host Dogfooding Automated Test Suite",
	() => {
		const paths = defaultPlatformPathService;
		const dogfoodExportDir = path.join(
			os.tmpdir(),
			`ct-dogfood-export-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		);
		const dogfoodFlagsExportDir = path.join(
			os.tmpdir(),
			`ct-dogfood-flags-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
		);

		// Invariant tracking: capture sample file stats before running tests
		const sampleFileStats = new Map<
			string,
			{ mtimeMs: number; size: number }
		>();

		beforeAll(async () => {
			// Discover initial sessions to identify sample files for read-only invariant checks
			const all = getAllProviders();
			for (const provider of all) {
				try {
					const available = await provider.isAvailable(paths);
					if (!available) continue;
					const sessions = await provider.discoverSessions(paths);
					if (sessions.length > 0 && sessions[0]?.filePath) {
						const fp = sessions[0].filePath;
						if (existsSync(fp)) {
							const st = statSync(fp);
							if (st.isFile()) {
								sampleFileStats.set(fp, { mtimeMs: st.mtimeMs, size: st.size });
							}
						}
					}
				} catch {
					// Silently ignore setup inspection errors
				}
			}
		});

		afterAll(() => {
			// Clean up temporary export directories
			try {
				if (existsSync(dogfoodExportDir)) {
					rmSync(dogfoodExportDir, { recursive: true, force: true });
				}
			} catch {
				// Ignore cleanup error
			}
			try {
				if (existsSync(dogfoodFlagsExportDir)) {
					rmSync(dogfoodFlagsExportDir, { recursive: true, force: true });
				}
			} catch {
				// Ignore cleanup error
			}
		});

		async function execCli(args: string[]) {
			const proc = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
				cwd: process.cwd(),
				env: process.env,
				stdout: "pipe",
				stderr: "pipe",
			});

			const exitCode = await proc.exited;
			const stdout = await new Response(proc.stdout).text();
			const stderr = await new Response(proc.stderr).text();
			return { exitCode, stdout, stderr };
		}

		// =========================================================================
		// Tier 1: Read-Only Host Discovery & Provider Architecture
		// =========================================================================
		describe("Tier 1: Read-Only Host Discovery", () => {
			test("DOGFOOD-T1-01: All 15 providers registered with complete metadata", () => {
				const providers = getAllProviders();
				expect(providers.length).toBe(15);

				const registeredIds = providers.map((p) => p.metadata.id);
				for (const expectedId of ALL_15_HARNESS_IDS) {
					expect(registeredIds).toContain(expectedId);
					const provider = getProvider(expectedId);
					expect(provider).toBeDefined();
					if (!provider) continue;

					expect(typeof provider.metadata.id).toBe("string");
					expect(typeof provider.metadata.displayName).toBe("string");
					expect(typeof provider.metadata.shortLabel).toBe("string");
					expect(typeof provider.metadata.color).toBe("string");
					if (provider.metadata.description !== undefined) {
						expect(typeof provider.metadata.description).toBe("string");
					}
					if (provider.metadata.defaultEnabled !== undefined) {
						expect(typeof provider.metadata.defaultEnabled).toBe("boolean");
					}
				}
			});

			test("DOGFOOD-T1-02: Safe isAvailable() check across all 15 providers using system paths", async () => {
				const providers = getAllProviders();
				for (const provider of providers) {
					const isAvail = await provider.isAvailable(paths);
					expect(typeof isAvail).toBe("boolean");
				}
			});

			test("DOGFOOD-T1-03: Real host available provider detection", async () => {
				const availableProviders = await getAvailableProviders(paths);
				expect(availableProviders.length).toBeGreaterThan(0);

				const availableIds = availableProviders.map((p) => p.metadata.id);
				// On this host, key mainstream harnesses are present
				for (const hostHarness of KNOWN_HOST_HARNESSES_WITH_SESSIONS) {
					expect(availableIds).toContain(hostHarness as HarnessId);
				}
			});

			test("DOGFOOD-T1-04: Graceful handling of uninstalled providers without crash", async () => {
				const providers = getAllProviders();
				for (const provider of providers) {
					const isAvail = await provider.isAvailable(paths);
					if (!isAvail) {
						// Uninstalled harnesses must return empty discovery results and clean fingerprints
						const sessions = await provider.discoverSessions(paths);
						expect(Array.isArray(sessions)).toBe(true);
						expect(sessions.length).toBe(0);

						const watchPaths = provider.getWatchPaths(paths);
						expect(Array.isArray(watchPaths)).toBe(true);

						const fingerprint = await provider.computeFingerprint(paths);
						expect(fingerprint).toMatch(/^v\d+:0:[0-9a-f]{16,64}$/);
					}
				}
			});

			test("DOGFOOD-T1-05: Real host session discovery returns structured session items", async () => {
				const availableProviders = await getAvailableProviders(paths);
				let totalDiscoveredAcrossHost = 0;

				for (const provider of availableProviders) {
					const sessions = await provider.discoverSessions(paths);
					expect(Array.isArray(sessions)).toBe(true);
					totalDiscoveredAcrossHost += sessions.length;

					for (const item of sessions) {
						expect(typeof item.sessionId).toBe("string");
						expect(item.sessionId.length).toBeGreaterThan(0);
						expect(item.harness).toBe(provider.metadata.id);
						expect(typeof item.filePath).toBe("string");
						expect(typeof item.sizeBytes).toBe("number");
						expect(item.sizeBytes).toBeGreaterThanOrEqual(0);
						expect(typeof item.mtimeMs).toBe("number");
						expect(item.mtimeMs).toBeGreaterThanOrEqual(0);
					}
				}

				// Host has over 2,000 live sessions
				expect(totalDiscoveredAcrossHost).toBeGreaterThan(1000);
			}, 30000);

			test("DOGFOOD-T1-06: Real session usage extraction for available providers with sessions", async () => {
				const availableProviders = await getAvailableProviders(paths);
				let totalRecordsExtracted = 0;

				for (const provider of availableProviders) {
					const sessions = await provider.discoverSessions(paths);
					if (sessions.length === 0) continue;

					const sample = sessions[0];
					if (!sample) continue;

					const usage = await provider.readUsage(paths, sample);
					expect(typeof usage.available).toBe("boolean");
					expect(Array.isArray(usage.records)).toBe(true);

					totalRecordsExtracted += usage.records.length;
					for (const rec of usage.records) {
						expect(rec.harness).toBe(provider.metadata.id);
						expect(typeof rec.model).toBe("string");
						expect(typeof rec.timestamp).toBe("number");
						expect(rec.timestamp).toBeGreaterThan(0);
						expect(rec.inputTokens).toBeGreaterThanOrEqual(0);
						expect(rec.outputTokens).toBeGreaterThanOrEqual(0);
						expect(rec.cacheReadTokens).toBeGreaterThanOrEqual(0);
						expect(rec.cacheWriteTokens).toBeGreaterThanOrEqual(0);
						expect(rec.reasoningTokens).toBeGreaterThanOrEqual(0);
					}
				}

				expect(totalRecordsExtracted).toBeGreaterThan(0);
			}, 30000);

			test("DOGFOOD-T1-07: Full usage sweep on installed harness", async () => {
				const clineProvider = getProvider("cline");
				expect(clineProvider).toBeDefined();
				if (clineProvider && (await clineProvider.isAvailable(paths))) {
					const sweep = await clineProvider.readUsage(paths);
					expect(sweep.available).toBe(true);
					expect(sweep.records.length).toBeGreaterThan(0);
					const firstRec = sweep.records[0];
					expect(firstRec).toBeDefined();
					if (firstRec) {
						expect(firstRec.inputTokens).toBeGreaterThan(0);
						expect(firstRec.outputTokens).toBeGreaterThan(0);
					}
				}
			});

			test("DOGFOOD-T1-08: Real host conversation transcript extraction", async () => {
				const availableProviders = await getAvailableProviders(paths);
				let verifiedTranscriptCount = 0;

				for (const provider of availableProviders) {
					const sessions = await provider.discoverSessions(paths);
					if (sessions.length === 0) continue;

					// Test the first session
					const sampleSession = sessions[0];
					if (!sampleSession) continue;

					const transcript = await provider.readTranscript(
						paths,
						sampleSession.sessionId,
					);
					if (
						transcript &&
						KNOWN_HOST_HARNESSES_WITH_SESSIONS.includes(provider.metadata.id)
					) {
						expect(transcript.sessionId).toBeDefined();
						expect(transcript.harness).toBe(provider.metadata.id);
						expect(Array.isArray(transcript.items)).toBe(true);
						expect(transcript.items.length).toBeGreaterThan(0);

						for (const item of transcript.items) {
							expect(typeof item.id).toBe("string");
							expect(typeof item.turnId).toBe("string");
							expect(typeof item.role).toBe("string");
							expect(typeof item.kind).toBe("string");
							expect(typeof item.order).toBe("number");
						}

						verifiedTranscriptCount += 1;
					}
				}

				// We must have successfully verified transcripts across multiple live harnesses
				expect(verifiedTranscriptCount).toBeGreaterThanOrEqual(5);
			}, 30000);

			test("DOGFOOD-T1-09: Deterministic fingerprinting and watch paths on host", async () => {
				const providers = getAllProviders();
				for (const provider of providers) {
					const watchPaths = provider.getWatchPaths(paths);
					expect(Array.isArray(watchPaths)).toBe(true);

					const fingerprint = await provider.computeFingerprint(paths);
					expect(typeof fingerprint).toBe("string");
					expect(fingerprint).toMatch(/^v\d+:\d+:[0-9a-f]{16,64}$/);

					// Second execution produces identical deterministic fingerprint
					const fingerprint2 = await provider.computeFingerprint(paths);
					expect(fingerprint2).toBe(fingerprint);
				}
			});
		});

		// =========================================================================
		// Tier 2: Real Host CLI Dogfooding
		// =========================================================================
		describe("Tier 2: Real Host CLI Dogfooding", () => {
			test("DOGFOOD-T2-01: Default CLI invocation renders formatted table with live host metrics", async () => {
				const res = await execCli([]);
				expect(res.exitCode).toBe(0);
				// Must contain box-drawing borders
				expect(res.stdout).toContain("┌");
				expect(res.stdout).toContain("┬");
				expect(res.stdout).toContain("┐");
				expect(res.stdout).toContain("├");
				expect(res.stdout).toContain("┼");
				expect(res.stdout).toContain("┤");
				expect(res.stdout).toContain("└");
				expect(res.stdout).toContain("┴");
				expect(res.stdout).toContain("┘");

				// Must contain standard table headers
				expect(res.stdout).toContain("Harness");
				expect(res.stdout).toContain("Project");
				expect(res.stdout).toContain("Model");
				expect(res.stdout).toContain("Sessions");
				expect(res.stdout).toContain("Requests");
				expect(res.stdout).toContain("Cost (USD)");

				// Must contain Total summary row
				expect(res.stdout).toContain("Total");

				// Must display live host harnesses
				expect(res.stdout).toContain("Codex");
				expect(res.stdout).toContain("Antigravity");
			}, 30000);

			test("DOGFOOD-T2-02: Full host CLI execution in JSON mode parses accurately", async () => {
				const res = await execCli(["--format", "json"]);
				expect(res.exitCode).toBe(0);

				const parsed = JSON.parse(res.stdout);
				expect(parsed).toHaveProperty("totals");
				expect(parsed).toHaveProperty("groups");
				expect(parsed).toHaveProperty("filters");

				// Host metrics verification against over 2,000 sessions
				expect(parsed.totals.sessions).toBeGreaterThan(1000);
				expect(parsed.totals.requests).toBeGreaterThan(10000);
				expect(parsed.totals.inputTokens).toBeGreaterThan(1000000);
				expect(parsed.totals.outputTokens).toBeGreaterThan(100000);
				expect(parsed.totals.costUsd).toBeGreaterThan(100);

				// Groups verification
				expect(Array.isArray(parsed.groups)).toBe(true);
				expect(parsed.groups.length).toBeGreaterThan(5);

				const harnessesInGroups = new Set(
					parsed.groups.map(
						(g: { values: { harness: string } }) => g.values.harness,
					),
				);
				expect(harnessesInGroups.has("codex")).toBe(true);
				expect(harnessesInGroups.has("antigravity")).toBe(true);
				expect(harnessesInGroups.has("commandcode")).toBe(true);
				expect(harnessesInGroups.has("opencode")).toBe(true);
				expect(harnessesInGroups.has("dsh")).toBe(true);
			}, 30000);

			test("DOGFOOD-T2-03: Per-harness live filtering flags execute cleanly", async () => {
				const harnessesToTest = [
					{ name: "claude", expectedInOutput: "Claude" },
					{ name: "codex", expectedInOutput: "Codex" },
					{ name: "continue", expectedInOutput: "Continue" },
					{ name: "cline", expectedInOutput: "Cline" },
					{ name: "antigravity", expectedInOutput: "Antigravity" },
					{ name: "opencode", expectedInOutput: "OpenCode" },
					{ name: "dsh", expectedInOutput: "DSH" },
					{ name: "commandcode", expectedInOutput: "Command Code" },
					{ name: "cursor", expectedInOutput: "" },
					{ name: "windsurf", expectedInOutput: "" },
					{ name: "copilot", expectedInOutput: "" },
				];

				for (const item of harnessesToTest) {
					const res = await execCli(["--harness", item.name]);
					expect(res.exitCode).toBe(0);
					if (item.expectedInOutput) {
						expect(res.stdout).toContain(item.expectedInOutput);
					}
				}
			}, 30000);

			test("DOGFOOD-T2-04: Graceful handling of uninstalled harness filter flag and invalid harness error", async () => {
				// Uninstalled harness (e.g. roo is registered but not installed on host) exits code 0 with empty report
				const res = await execCli(["--harness", "roo"]);
				expect(res.exitCode).toBe(0);
				expect(res.stdout).toContain("No usage records found.");

				// Invalid harness name exits code 2 with descriptive error
				const resInvalid = await execCli([
					"--harness",
					"non-existent-harness-xyz",
				]);
				expect(resInvalid.exitCode).toBe(2);
				expect(resInvalid.stderr).toContain("Error: --harness accepts:");
			});

			test("DOGFOOD-T2-05: Real host CLI dynamic grouping (--by)", async () => {
				// Group by harness
				const resHarness = await execCli([
					"--format",
					"json",
					"--harness",
					"cline,claude",
					"--by",
					"harness",
				]);
				expect(resHarness.exitCode).toBe(0);
				const parsedHarness = JSON.parse(resHarness.stdout);
				expect(parsedHarness.groupBy).toEqual(["harness"]);
				for (const group of parsedHarness.groups) {
					expect(group.values).toHaveProperty("harness");
					expect(group.values).not.toHaveProperty("model");
					expect(group.values).not.toHaveProperty("project");
				}

				// Group by model
				const resModel = await execCli([
					"--format",
					"json",
					"--harness",
					"cline,claude",
					"--by",
					"model",
				]);
				expect(resModel.exitCode).toBe(0);
				const parsedModel = JSON.parse(resModel.stdout);
				expect(parsedModel.groupBy).toEqual(["model"]);
				for (const group of parsedModel.groups) {
					expect(group.values).toHaveProperty("model");
					expect(group.values).not.toHaveProperty("harness");
				}

				// Group by project
				const resProject = await execCli([
					"--format",
					"json",
					"--harness",
					"cline,claude",
					"--by",
					"project",
				]);
				expect(resProject.exitCode).toBe(0);
				const parsedProject = JSON.parse(resProject.stdout);
				expect(parsedProject.groupBy).toEqual(["project"]);
				for (const group of parsedProject.groups) {
					expect(group.values).toHaveProperty("project");
					expect(group.values).not.toHaveProperty("harness");
				}
			});

			test("DOGFOOD-T2-06: Live Markdown export to isolated directory", async () => {
				const res = await execCli([
					"--harness",
					"cline",
					"--export-dir",
					dogfoodExportDir,
					"--detail",
					"chat",
				]);
				expect(res.exitCode).toBe(0);
				expect(res.stdout).toContain("Exported");

				// Check that _index.md was created
				const indexPath = path.join(dogfoodExportDir, "_index.md");
				expect(existsSync(indexPath)).toBe(true);

				const indexContent = readFileSync(indexPath, "utf8");
				expect(indexContent).toContain("# Conversations");
				expect(indexContent).toContain("cline/");

				// Check that exported markdown file exists and has content
				const clineDir = path.join(dogfoodExportDir, "cline");
				expect(existsSync(clineDir)).toBe(true);

				const projectEntries = readdirSync(clineDir);
				expect(projectEntries.length).toBeGreaterThan(0);

				const projectDir = path.join(clineDir, projectEntries[0] ?? "");
				const mdFiles = readdirSync(projectDir).filter((f) =>
					f.endsWith(".md"),
				);
				expect(mdFiles.length).toBeGreaterThan(0);

				const mdContent = readFileSync(
					path.join(projectDir, mdFiles[0] ?? ""),
					"utf8",
				);
				expect(mdContent.length).toBeGreaterThan(0);
				expect(mdContent).toContain(
					"<!-- generated by harness-token-usage -->",
				);
				expect(mdContent).toContain("# ");
			});

			test("DOGFOOD-T2-07: Live Markdown export with timestamps and token stats", async () => {
				const res = await execCli([
					"--harness",
					"cline",
					"--export-dir",
					dogfoodFlagsExportDir,
					"--include-timestamps",
					"--include-token-stats",
					"--detail",
					"chat_tools",
				]);
				expect(res.exitCode).toBe(0);
				expect(res.stdout).toContain("Exported");

				const clineDir = path.join(dogfoodFlagsExportDir, "cline");
				expect(existsSync(clineDir)).toBe(true);
				const projectEntries = readdirSync(clineDir);
				const projectDir = path.join(clineDir, projectEntries[0] ?? "");
				const mdFiles = readdirSync(projectDir).filter((f) =>
					f.endsWith(".md"),
				);
				expect(mdFiles.length).toBeGreaterThan(0);

				const mdContent = readFileSync(
					path.join(projectDir, mdFiles[0] ?? ""),
					"utf8",
				);
				expect(mdContent.length).toBeGreaterThan(0);
			});
		});

		// =========================================================================
		// Tier 3: Safety & Non-Destructive Invariant
		// =========================================================================
		describe("Tier 3: Safety & Non-Destructive Invariant", () => {
			test("DOGFOOD-T3-01: Real user session files remain completely unmodified", () => {
				expect(sampleFileStats.size).toBeGreaterThan(0);

				for (const [filePath, initialStat] of sampleFileStats.entries()) {
					expect(existsSync(filePath)).toBe(true);
					const currentStat = statSync(filePath);
					expect(currentStat.mtimeMs).toBe(initialStat.mtimeMs);
					expect(currentStat.size).toBe(initialStat.size);
				}
			});

			test("DOGFOOD-T3-02: Zero pollution or rogue temporary files in user home directory", () => {
				const home = paths.getHomeDir();
				const filesInHome = readdirSync(home);
				// Verify no temporary files created directly in home directory
				const rogueFiles = filesInHome.filter(
					(f) =>
						f.startsWith("ct-dogfood-") ||
						f.startsWith("temp-dogfood-") ||
						f.startsWith("ct-cli-suite-"),
				);
				expect(rogueFiles).toEqual([]);
			});
		});
	},
);
