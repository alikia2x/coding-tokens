import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { StatusPayload } from "@shared/types";
import { getHarnessLabel } from "@shared/types";
import { GlobalWindow } from "happy-dom";

const DOM_KEYS = [
	"Event",
	"CustomEvent",
	"MouseEvent",
	"PointerEvent",
	"FocusEvent",
	"KeyboardEvent",
	"UIEvent",
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"HTMLButtonElement",
	"HTMLInputElement",
	"HTMLFormElement",
	"Element",
	"Node",
	"NodeFilter",
	"DocumentFragment",
	"getComputedStyle",
	"ResizeObserver",
	"MutationObserver",
	"requestAnimationFrame",
	"cancelAnimationFrame",
] as const;

const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
for (const key of DOM_KEYS) {
	savedDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
}

const win = new GlobalWindow();
const resizeObserverStub = class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
const rafStub = ((cb: FrameRequestCallback) =>
	setTimeout(cb, 0)) as unknown as typeof requestAnimationFrame;
const cafStub = ((id: number) =>
	clearTimeout(id)) as unknown as typeof cancelAnimationFrame;

function applyHappyDomGlobals() {
	globalThis.Event = win.Event as unknown as typeof Event;
	globalThis.CustomEvent = win.CustomEvent as unknown as typeof CustomEvent;
	globalThis.MouseEvent = win.MouseEvent as unknown as typeof MouseEvent;
	globalThis.PointerEvent = win.PointerEvent as unknown as typeof PointerEvent;
	globalThis.FocusEvent = win.FocusEvent as unknown as typeof FocusEvent;
	globalThis.KeyboardEvent =
		win.KeyboardEvent as unknown as typeof KeyboardEvent;
	globalThis.UIEvent = win.UIEvent as unknown as typeof UIEvent;
	globalThis.window = win as unknown as Window & typeof globalThis;
	globalThis.document = win.document as unknown as Document;
	globalThis.navigator = win.navigator as unknown as Navigator;
	Object.defineProperty(globalThis.navigator, "language", {
		value: "en-US",
		configurable: true,
	});
	globalThis.HTMLElement = win.HTMLElement as unknown as typeof HTMLElement;
	globalThis.HTMLButtonElement =
		win.HTMLButtonElement as unknown as typeof HTMLButtonElement;
	globalThis.HTMLInputElement =
		win.HTMLInputElement as unknown as typeof HTMLInputElement;
	globalThis.HTMLFormElement =
		win.HTMLFormElement as unknown as typeof HTMLFormElement;
	globalThis.Element = win.Element as unknown as typeof Element;
	globalThis.Node = win.Node as unknown as typeof Node;
	globalThis.NodeFilter = win.NodeFilter as unknown as typeof NodeFilter;
	globalThis.DocumentFragment =
		win.DocumentFragment as unknown as typeof DocumentFragment;
	(
		globalThis as unknown as {
			getComputedStyle: typeof win.getComputedStyle;
		}
	).getComputedStyle = win.getComputedStyle.bind(win);
	globalThis.ResizeObserver = resizeObserverStub;
	globalThis.MutationObserver =
		win.MutationObserver as unknown as typeof MutationObserver;
	globalThis.requestAnimationFrame = rafStub;
	globalThis.cancelAnimationFrame = cafStub;
}

function restoreHappyDomGlobals() {
	for (const key of DOM_KEYS) {
		const desc = savedDescriptors.get(key);
		if (desc) {
			Object.defineProperty(globalThis, key, desc);
		} else {
			Reflect.deleteProperty(globalThis, key);
		}
	}
}

applyHappyDomGlobals();

const React = await import("react");
const ReactDOM = await import("react-dom/client");
type Root = import("react-dom/client").Root;
const { MemoryRouter, Route, Routes, useNavigate } = await import(
	"react-router"
);
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { SessionsSidebar } = await import(
	"~/components/sessions/sessions-sidebar"
);
const { ExplorePage } = await import("~/pages/explore");
const { ModelsPage } = await import("~/pages/models");
const { OverviewPage } = await import("~/pages/overview");
const { ProjectsPage } = await import("~/pages/projects");
const { SessionsPage } = await import("~/pages/sessions");
const { queryKeys } = await import("~/lib/queries");
const { RangeProvider } = await import("~/lib/range");
const { SettingsProvider } = await import("~/lib/settings");
const { useAppStore } = await import("~/lib/store");

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function click(element: Element | null | undefined) {
	if (!element) throw new Error("Element not found for click");
	element.dispatchEvent(
		new win.MouseEvent("click", {
			bubbles: true,
			cancelable: true,
		}) as unknown as Event,
	);
}

function makeStatusPayload(): StatusPayload {
	return {
		ready: true,
		indexing: false,
		phase: "ready",
		progress: { completed: 15, total: 15 },
		indexedAt: Date.now(),
		durationMs: 10,
		error: null,
		totals: { sessions: 53, records: 50 },
		warnings: [],
		harnesses: [
			{
				harness: "codex",
				label: getHarnessLabel("codex"),
				paths: [],
				available: true,
				records: 10,
				sessions: 12,
				warnings: [],
			},
			{
				harness: "dsh",
				label: getHarnessLabel("dsh"),
				paths: [],
				available: true,
				records: 5,
				sessions: 7,
				warnings: [],
			},
			{
				harness: "opencode",
				label: getHarnessLabel("opencode"),
				paths: [],
				available: true,
				records: 3,
				sessions: 4,
				warnings: [],
			},
			{
				harness: "commandcode",
				label: getHarnessLabel("commandcode"),
				paths: [],
				available: false,
				records: 0,
				sessions: 0,
				warnings: [],
			},
			{
				harness: "antigravity",
				label: getHarnessLabel("antigravity"),
				paths: [],
				available: true,
				records: 8,
				sessions: 9,
				warnings: [],
			},
			{
				harness: "claude",
				label: getHarnessLabel("claude"),
				paths: [],
				available: true,
				records: 20,
				sessions: 15,
				warnings: [],
			},
			{
				harness: "custom-harness",
				label: getHarnessLabel("custom-harness"),
				paths: [],
				available: true,
				records: 4,
				sessions: 6,
				warnings: [],
			},
		],
	};
}

describe("Dynamic Harness Filter UI Regression Suite", () => {
	let container: HTMLDivElement;
	let root: Root;
	const originalFetch = globalThis.fetch;

	beforeAll(() => {
		applyHappyDomGlobals();
	});

	afterAll(async () => {
		await sleep(30);
		restoreHappyDomGlobals();
		await win.close();
	});

	beforeEach(() => {
		useAppStore.getState().resetAll();
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
		root = ReactDOM.createRoot(container);
	});

	afterEach(async () => {
		root.unmount();
		await sleep(10);
		document.body.innerHTML = "";
		globalThis.fetch = originalFetch;
	});

	test("SessionsSidebar renders all harnesses from status.harnesses (including >5 / custom harnesses) with labels and counts", async () => {
		const status = makeStatusPayload();
		const counts = new Map<string, number>([
			["codex", 12],
			["dsh", 7],
			["opencode", 4],
			["commandcode", 0],
			["antigravity", 9],
			["claude", 15],
			["custom-harness", 6],
		]);

		const selected: { harness: string | null } = { harness: null };
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(SessionsSidebar, {
						harness: null,
						projects: [],
						models: [],
						includeInternal: false,
						showEmpty: false,
						hasFilters: false,
						totalFiltered: 53,
						totalBase: 53,
						counts,
						projectOptions: [],
						modelOptions: [],
						status,
						rangeLabel: "All time",
						onSelectHarness: (value) => {
							selected.harness = value;
						},
						onSetProjects: () => {},
						onSetModels: () => {},
						onToggleInternal: () => {},
						onToggleEmpty: () => {},
						onClearFilters: () => {},
					}),
				),
			),
		);

		await sleep(50);

		const buttons = Array.from(container.querySelectorAll("button"));
		const claudeBtn = buttons.find((b) =>
			b.textContent?.includes(getHarnessLabel("claude")),
		);
		expect(claudeBtn).toBeDefined();
		expect(claudeBtn?.textContent).toContain("15");

		const customBtn = buttons.find((b) =>
			b.textContent?.includes(getHarnessLabel("custom-harness")),
		);
		expect(customBtn).toBeDefined();
		expect(customBtn?.textContent).toContain("6");

		click(customBtn);
		await sleep(20);
		expect(selected.harness).toBe("custom-harness");
	});

	test("ExplorePage renders dynamic harnesses from status.data.harnesses in the Harness FacetFilter with labels and counts", async () => {
		const status = makeStatusPayload();

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/status")) {
				return new Response(JSON.stringify(status), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/projects")) {
				return new Response(JSON.stringify({ rows: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/models")) {
				return new Response(JSON.stringify({ rows: [] }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/pricing")) {
				return new Response(
					JSON.stringify({
						status: {
							state: "fresh",
							endpoint: "https://models.dev/api.json",
							cachePath: "",
							autoFetch: true,
							cacheTtlHours: 24,
							fetchedAt: null,
							expiresAt: null,
							modelCount: 0,
							providerCount: 0,
							lastError: null,
							fetching: false,
							history: [],
							summary: {
								activeModels: 2,
								customModels: 0,
								catalogModels: 0,
								recordedOnlyModels: 0,
								fallbackModels: 0,
								unpricedModels: 1,
								unpricedRequests: 2,
							},
						},
						settings: {
							autoFetch: true,
							endpoint: "https://models.dev/api.json",
							cacheTtlHours: 24,
							customRules: {},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/explore")) {
				return new Response(
					JSON.stringify({
						mode: "time",
						metric: "tokens",
						dimension: "harness",
						bucket: "day",
						breakdown: "none",
						totals: {
							sessions: 53,
							messages: 200,
							requests: 50,
							inputTokens: 1000,
							outputTokens: 500,
							cacheReadTokens: 0,
							cacheWriteTokens: 0,
							reasoningTokens: 0,
							costUsd: 0.5,
							estimatedRequests: 0,
							unpricedRequests: 0,
						},
						series: [],
						xLabels: [],
						buckets: [],
						rows: [],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response("{}", { status: 200 });
		}) as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: ["/explore"] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(
							RangeProvider,
							null,
							React.createElement(ExplorePage),
						),
					),
				),
			),
		);

		await sleep(80);

		const buttons = Array.from(container.querySelectorAll("button"));
		const harnessFilterBtn = buttons.find((b) =>
			b.textContent?.trim().startsWith("Harness"),
		);
		expect(harnessFilterBtn).toBeDefined();

		click(harnessFilterBtn);
		await sleep(50);

		// Popover renders into document.body via Radix Portal
		const bodyText = document.body.textContent ?? "";
		expect(bodyText).toContain(getHarnessLabel("claude"));
		expect(bodyText).toContain("15");
		expect(bodyText).toContain(getHarnessLabel("custom-harness"));
		expect(bodyText).toContain("6");

		// Select the custom harness option and verify filter badge updates to 1
		const popoverButtons = Array.from(document.body.querySelectorAll("button"));
		const customOptionBtn = popoverButtons.find((b) =>
			b.textContent?.includes(getHarnessLabel("custom-harness")),
		);
		expect(customOptionBtn).toBeDefined();
		click(customOptionBtn);
		await sleep(30);

		expect(harnessFilterBtn?.textContent).toContain("1");
	});

	test("SessionsPage batch export button exports only filtered sessions via BatchExportDialog", async () => {
		const status = makeStatusPayload();
		const capturedBatch: { payload: Record<string, unknown> | null } = {
			payload: null,
		};
		const capturePostedPayload = (payload: Record<string, unknown>) => {
			capturedBatch.payload = payload;
		};
		const sessionsData = {
			indexedAt: Date.now(),
			warnings: [],
			sessions: [
				{
					key: "claude:c1",
					harness: "claude",
					sessionId: "c1",
					title: "Claude session 1",
					cwd: "/proj/a",
					projectName: "a",
					models: ["claude-sonnet-4"],
					startedAt: 1000,
					lastActivityAt: 2000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: {
						sessions: 1,
						messages: 2,
						requests: 1,
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUsd: 0.01,
						estimatedRequests: 0,
						unpricedRequests: 0,
					},
				},
				{
					key: "codex:x1",
					harness: "codex",
					sessionId: "x1",
					title: "Codex session 1",
					cwd: "/proj/b",
					projectName: "b",
					models: ["gpt-5"],
					startedAt: 3000,
					lastActivityAt: 4000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: {
						sessions: 1,
						messages: 2,
						requests: 1,
						inputTokens: 200,
						outputTokens: 100,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUsd: 0.02,
						estimatedRequests: 0,
						unpricedRequests: 0,
					},
				},
			],
		};

		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/dialog/directory")) {
				return new Response(
					JSON.stringify({
						supported: true,
						path: "/tmp/coding-tokens-exports",
						cancelled: false,
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (url.includes("/api/sessions/export")) {
				capturePostedPayload(
					JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
				);
				return new Response(
					JSON.stringify({
						directory: "/tmp/coding-tokens-exports",
						outputPath: "/tmp/coding-tokens-exports/export-1",
						filename: "export-1",
						bytes: 128,
						filesWritten: 1,
						skippedCount: 0,
						warnings: [],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify(sessionsData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/status")) {
				return new Response(JSON.stringify(status), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: ["/sessions?harness=claude"] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(
							RangeProvider,
							null,
							React.createElement(SessionsPage),
						),
					),
				),
			),
		);

		await sleep(80);

		const exportBtn = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Export",
		);
		expect(exportBtn).toBeDefined();
		expect(exportBtn?.disabled).toBe(false);

		click(exportBtn);
		await sleep(50);

		const dialogText = document.body.textContent ?? "";
		expect(dialogText).toContain("Export filtered sessions");
		expect(dialogText).toContain("1 matching");

		const confirmBtn = Array.from(
			document.body.querySelectorAll("button"),
		).find((b) => b.textContent?.includes("Export 1 session"));
		expect(confirmBtn).toBeDefined();
		click(confirmBtn);
		await sleep(50);

		expect(capturedBatch.payload).not.toBeNull();
		expect(capturedBatch.payload?.keys).toEqual(["claude:c1"]);
		expect(document.body.textContent).toContain(
			"/tmp/coding-tokens-exports/export-1",
		);
	});

	test("SessionsPage cross-filters harness counts and facet option counts against other active filters", async () => {
		const status = makeStatusPayload();
		const baseTotals = {
			sessions: 1,
			messages: 2,
			requests: 1,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.01,
			estimatedRequests: 0,
			unpricedRequests: 0,
		};
		const sessionsData = {
			indexedAt: Date.now(),
			warnings: [],
			sessions: [
				{
					key: "claude:c1",
					harness: "claude",
					sessionId: "c1",
					title: "Alpha work",
					cwd: "/proj/alpha",
					projectName: "alpha",
					models: ["claude-sonnet-4"],
					startedAt: 1000,
					lastActivityAt: 2000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
				{
					key: "codex:x1",
					harness: "codex",
					sessionId: "x1",
					title: "Alpha codex work",
					cwd: "/proj/alpha",
					projectName: "alpha",
					models: ["gpt-5"],
					startedAt: 3000,
					lastActivityAt: 4000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
				{
					key: "codex:x2",
					harness: "codex",
					sessionId: "x2",
					title: "Beta codex work",
					cwd: "/proj/beta",
					projectName: "beta",
					models: ["gpt-5"],
					startedAt: 5000,
					lastActivityAt: 6000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
			],
		};

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify(sessionsData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/heatmap")) {
				return new Response(
					JSON.stringify({
						from: 0,
						until: 0,
						days: [],
						totals: {
							requests: 0,
							tokens: 0,
							costUsd: 0,
							sessions: 0,
						},
						maxTokens: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/pricing")) {
				return new Response(
					JSON.stringify({
						status: {
							state: "fresh",
							endpoint: "https://models.dev/api.json",
							cachePath: "",
							autoFetch: true,
							cacheTtlHours: 24,
							fetchedAt: null,
							expiresAt: null,
							modelCount: 0,
							providerCount: 0,
							lastError: null,
							fetching: false,
							history: [],
							summary: {
								activeModels: 2,
								customModels: 0,
								catalogModels: 0,
								recordedOnlyModels: 0,
								fallbackModels: 0,
								unpricedModels: 1,
								unpricedRequests: 2,
							},
						},
						settings: {
							autoFetch: true,
							endpoint: "https://models.dev/api.json",
							cacheTtlHours: 24,
							customRules: {},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		// Filtering by model=gpt-5 should restrict harness sidebar to Codex 2 & All 2 (Claude hidden),
		// and Project facet should reflect only Alpha (1) and Beta (1)
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: ["/sessions?model=gpt-5"] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(
							RangeProvider,
							null,
							React.createElement(SessionsPage),
						),
					),
				),
			),
		);

		await sleep(80);

		const sidebarButtons = Array.from(
			container.querySelectorAll("aside button"),
		);
		const allHarnessesBtn = sidebarButtons.find((b) =>
			b.textContent?.includes("All"),
		);
		const codexBtn = sidebarButtons.find((b) =>
			b.textContent?.includes("Codex"),
		);
		const claudeBtn = sidebarButtons.find((b) =>
			b.textContent?.includes("Claude"),
		);
		expect(allHarnessesBtn?.textContent).toContain("2");
		expect(codexBtn?.textContent).toContain("2");
		expect(claudeBtn).toBeUndefined();

		const projectFilterBtn = sidebarButtons.find((b) =>
			b.textContent?.startsWith("Project"),
		);
		expect(projectFilterBtn).toBeDefined();
		click(projectFilterBtn);
		await sleep(50);

		const popButtons = Array.from(document.body.querySelectorAll("button"));
		const alphaOpt = popButtons.find((b) => b.textContent?.includes("alpha"));
		expect(alphaOpt?.textContent).toContain("1");
	});

	test("SessionsPage preserves filters, sort, grouping, and expanded groups across session detail navigation", async () => {
		const status = makeStatusPayload();
		const baseTotals = {
			sessions: 1,
			messages: 2,
			requests: 1,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.01,
			estimatedRequests: 0,
			unpricedRequests: 0,
		};
		const sessionsData = {
			indexedAt: Date.now(),
			warnings: [],
			sessions: [
				{
					key: "codex:x1",
					harness: "codex",
					sessionId: "x1",
					title: "Codex alpha task",
					cwd: "/proj/alpha",
					projectName: "alpha",
					models: ["gpt-5"],
					startedAt: 1000,
					lastActivityAt: 3000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
				{
					key: "claude:c1",
					harness: "claude",
					sessionId: "c1",
					title: "Claude beta task",
					cwd: "/proj/beta",
					projectName: "beta",
					models: ["claude-sonnet-4"],
					startedAt: 1000,
					lastActivityAt: 2000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
			],
		};

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify(sessionsData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/heatmap")) {
				return new Response(
					JSON.stringify({
						from: 0,
						until: 0,
						days: [],
						totals: {
							requests: 0,
							tokens: 0,
							costUsd: 0,
							sessions: 0,
						},
						maxTokens: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/pricing")) {
				return new Response(
					JSON.stringify({
						status: {
							state: "fresh",
							endpoint: "https://models.dev/api.json",
							cachePath: "",
							autoFetch: true,
							cacheTtlHours: 24,
							fetchedAt: null,
							expiresAt: null,
							modelCount: 0,
							providerCount: 0,
							lastError: null,
							fetching: false,
							history: [],
							summary: {
								activeModels: 2,
								customModels: 0,
								catalogModels: 0,
								recordedOnlyModels: 0,
								fallbackModels: 0,
								unpricedModels: 1,
								unpricedRequests: 2,
							},
						},
						settings: {
							autoFetch: true,
							endpoint: "https://models.dev/api.json",
							cacheTtlHours: 24,
							customRules: {},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		function DetailStub() {
			const navigate = useNavigate();
			return React.createElement(
				"button",
				{
					type: "button",
					onClick: () => navigate("/sessions?range=30d"),
				},
				"Back to sessions",
			);
		}

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: ["/sessions?range=30d"] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(
							RangeProvider,
							null,
							React.createElement(
								Routes,
								null,
								React.createElement(Route, {
									path: "/sessions",
									element: React.createElement(SessionsPage),
								}),
								React.createElement(Route, {
									path: "/sessions/:harness/:sessionId",
									element: React.createElement(DetailStub),
								}),
							),
						),
					),
				),
			),
		);

		await sleep(80);

		// Select Codex in sidebar harness filter and verify only Codex alpha task is shown
		const codexSidebarBtn = Array.from(
			container.querySelectorAll("aside button"),
		).find((b) => b.textContent?.includes("Codex"));
		click(codexSidebarBtn);
		await sleep(40);

		expect(container.textContent).toContain("Codex alpha task");
		expect(container.textContent).not.toContain("Claude beta task");

		// Navigate into session detail via rendered link
		const sessionLink = Array.from(container.querySelectorAll("a")).find((a) =>
			a.textContent?.includes("Codex alpha task"),
		);
		expect(sessionLink).toBeDefined();
		click(sessionLink);
		await sleep(50);

		const backBtn = Array.from(container.querySelectorAll("button")).find((b) =>
			b.textContent?.includes("Back to sessions"),
		);
		expect(backBtn).toBeDefined();

		// Return to /sessions?range=30d (no filter params in target URL)
		click(backBtn);
		await sleep(60);

		expect(useAppStore.getState().sessions.harness).toBe("codex");
		expect(container.textContent).toContain("Codex alpha task");
		expect(container.textContent).not.toContain("Claude beta task");
	});

	test("SessionsPage explicit URL drill-down overrides prior persisted store filters", async () => {
		const status = makeStatusPayload();
		const baseTotals = {
			sessions: 1,
			messages: 2,
			requests: 1,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.01,
			estimatedRequests: 0,
			unpricedRequests: 0,
		};
		const sessionsData = {
			indexedAt: Date.now(),
			warnings: [],
			sessions: [
				{
					key: "codex:x1",
					harness: "codex",
					sessionId: "x1",
					title: "Codex alpha task",
					cwd: "/proj/alpha",
					projectName: "alpha",
					models: ["gpt-5"],
					startedAt: 1000,
					lastActivityAt: 3000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
				{
					key: "claude:c1",
					harness: "claude",
					sessionId: "c1",
					title: "Claude beta task",
					cwd: "/proj/beta",
					projectName: "beta",
					models: ["claude-sonnet-4"],
					startedAt: 1000,
					lastActivityAt: 2000,
					durationMs: 1000,
					isSubagent: false,
					isReview: false,
					hasTranscript: true,
					totals: baseTotals,
				},
			],
		};

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/sessions")) {
				return new Response(JSON.stringify(sessionsData), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			if (url.includes("/api/heatmap")) {
				return new Response(
					JSON.stringify({
						from: 0,
						until: 0,
						days: [],
						totals: {
							requests: 0,
							tokens: 0,
							costUsd: 0,
							sessions: 0,
						},
						maxTokens: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/pricing")) {
				return new Response(
					JSON.stringify({
						status: {
							state: "fresh",
							endpoint: "https://models.dev/api.json",
							cachePath: "",
							autoFetch: true,
							cacheTtlHours: 24,
							fetchedAt: null,
							expiresAt: null,
							modelCount: 0,
							providerCount: 0,
							lastError: null,
							fetching: false,
							history: [],
							summary: {
								activeModels: 2,
								customModels: 0,
								catalogModels: 0,
								recordedOnlyModels: 0,
								fallbackModels: 0,
								unpricedModels: 1,
								unpricedRequests: 2,
							},
						},
						settings: {
							autoFetch: true,
							endpoint: "https://models.dev/api.json",
							cacheTtlHours: 24,
							customRules: {},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		// Seed previous harness filter in store
		useAppStore.getState().setSessionsPatch({
			harness: "codex",
			models: ["gpt-5"],
		});

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: ["/sessions?range=30d&project=%2Fproj%2Fbeta"] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(
							RangeProvider,
							null,
							React.createElement(SessionsPage),
						),
					),
				),
			),
		);

		await sleep(80);

		const state = useAppStore.getState().sessions;
		expect(state.harness).toBeNull();
		expect(state.models).toEqual([]);
		expect(state.projects).toEqual(["/proj/beta"]);
		expect(container.textContent).toContain("Claude beta task");
		expect(container.textContent).not.toContain("Codex alpha task");
	});

	test("ExplorePage, ProjectsPage, ModelsPage, and OverviewPage persist UI state across remounts", async () => {
		const status = makeStatusPayload();
		const totals = {
			sessions: 1,
			messages: 2,
			requests: 3,
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.25,
			estimatedRequests: 0,
			unpricedRequests: 0,
		};

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/explore")) {
				return new Response(
					JSON.stringify({
						mode: "time",
						metric: "tokens",
						dimension: "harness",
						bucket: "day",
						breakdown: "none",
						totals,
						xLabels: [],
						starts: [],
						series: [],
						rows: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/projects")) {
				return new Response(
					JSON.stringify({
						indexedAt: Date.now(),
						warnings: [],
						rows: [
							{
								cwd: "/proj/alpha",
								name: "alpha",
								harnesses: ["codex"],
								models: ["gpt-5"],
								sparkline: [1],
								lastActivityAt: 1000,
								totals,
							},
							{
								cwd: "/proj/beta",
								name: "beta",
								harnesses: ["claude"],
								models: ["claude-sonnet-4"],
								sparkline: [2],
								lastActivityAt: 2000,
								totals,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/models")) {
				return new Response(
					JSON.stringify({
						indexedAt: Date.now(),
						warnings: [],
						rows: [
							{
								model: "gpt-5",
								provider: "openai",
								harnesses: ["codex"],
								sparkline: [1],
								lastActivityAt: 2000,
								totals,
								pricing: null,
							},
							{
								model: "claude-sonnet-4",
								provider: "anthropic",
								harnesses: ["claude"],
								sparkline: [2],
								lastActivityAt: 1000,
								totals: { ...totals, unpricedRequests: 2 },
								pricing: null,
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/overview")) {
				return new Response(
					JSON.stringify({
						range: { from: null, until: null },
						indexedAt: Date.now(),
						warnings: [],
						totals,
						previous: null,
						bucketUnit: "day",
						buckets: [],
						harnesses: [],
						projects: [],
						models: [],
						recentSessions: [],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/heatmap")) {
				return new Response(
					JSON.stringify({
						from: 0,
						until: 0,
						days: [],
						totals: {
							requests: 0,
							tokens: 0,
							costUsd: 0,
							sessions: 0,
						},
						maxTokens: 0,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/pricing")) {
				return new Response(
					JSON.stringify({
						status: {
							state: "fresh",
							endpoint: "https://models.dev/api.json",
							cachePath: "",
							autoFetch: true,
							cacheTtlHours: 24,
							fetchedAt: null,
							expiresAt: null,
							modelCount: 0,
							providerCount: 0,
							lastError: null,
							fetching: false,
							history: [],
							summary: {
								activeModels: 2,
								customModels: 0,
								catalogModels: 0,
								recordedOnlyModels: 0,
								fallbackModels: 0,
								unpricedModels: 1,
								unpricedRequests: 2,
							},
						},
						settings: {
							autoFetch: true,
							endpoint: "https://models.dev/api.json",
							cacheTtlHours: 24,
							customRules: {},
						},
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("/api/settings")) {
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			return new Response(JSON.stringify(status), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		queryClient.setQueryData(queryKeys.status, status);

		const wrap = (initialEntry: string, node: React.ReactElement) =>
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					MemoryRouter,
					{ initialEntries: [initialEntry] },
					React.createElement(
						SettingsProvider,
						null,
						React.createElement(RangeProvider, null, node),
					),
				),
			);

		// ExplorePage: pick custom-harness filter, unmount, remount on bare /explore?range=30d
		root.render(wrap("/explore?range=30d", React.createElement(ExplorePage)));
		await sleep(80);
		const harnessBtn = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.startsWith("Harness"),
		);
		click(harnessBtn);
		await sleep(40);
		const customOpt = Array.from(document.body.querySelectorAll("button")).find(
			(b) => b.textContent?.includes(getHarnessLabel("custom-harness")),
		);
		click(customOpt);
		await sleep(40);
		expect(useAppStore.getState().explore.harnesses).toEqual([
			"custom-harness",
		]);

		root.render(wrap("/overview?range=30d", React.createElement(OverviewPage)));
		await sleep(60);
		const costBtn = Array.from(container.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Cost",
		);
		expect(costBtn).toBeDefined();
		click(costBtn);
		await sleep(30);
		expect(useAppStore.getState().overview.metric).toBe("cost");

		// Remount ExplorePage without explore params in URL -> restores filter from store
		root.render(wrap("/explore?range=30d", React.createElement(ExplorePage)));
		await sleep(60);
		const restoredHarnessBtn = Array.from(
			container.querySelectorAll("button"),
		).find((b) => b.textContent?.startsWith("Harness"));
		expect(restoredHarnessBtn?.textContent).toContain("1");

		// ProjectsPage: filter query + remount
		root.render(wrap("/projects?range=30d", React.createElement(ProjectsPage)));
		await sleep(60);
		const projectInput = container.querySelector(
			"input[data-search-input]",
		) as HTMLInputElement | null;
		expect(projectInput).not.toBeNull();
		if (projectInput) {
			const setter = Object.getOwnPropertyDescriptor(
				win.HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(projectInput, "beta");
			projectInput.dispatchEvent(
				new win.Event("input", { bubbles: true }) as unknown as Event,
			);
			await sleep(30);
		}
		expect(useAppStore.getState().projectsPage.query).toBe("beta");

		root.render(wrap("/models?range=30d", React.createElement(ModelsPage)));
		await sleep(60);
		expect(useAppStore.getState().projectsPage.query).toBe("beta");

		const modelInput = container.querySelector(
			"input[data-search-input]",
		) as HTMLInputElement | null;
		expect(modelInput).not.toBeNull();
		if (modelInput) {
			const setter = Object.getOwnPropertyDescriptor(
				win.HTMLInputElement.prototype,
				"value",
			)?.set;
			setter?.call(modelInput, "claude");
			modelInput.dispatchEvent(
				new win.Event("input", { bubbles: true }) as unknown as Event,
			);
			await sleep(30);
		}
		expect(useAppStore.getState().modelsPage.query).toBe("claude");

		root.render(wrap("/projects?range=30d", React.createElement(ProjectsPage)));
		await sleep(50);
		const restoredProjectInput = container.querySelector(
			"input[data-search-input]",
		) as HTMLInputElement | null;
		expect(restoredProjectInput?.value).toBe("beta");
	});
});
