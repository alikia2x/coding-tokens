import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StatusPayload } from "@shared/types";
import { getHarnessLabel } from "@shared/types";
import { GlobalWindow } from "happy-dom";

const win = new GlobalWindow();
globalThis.Event = win.Event;
globalThis.CustomEvent = win.CustomEvent;
globalThis.MouseEvent = win.MouseEvent;
globalThis.PointerEvent = win.PointerEvent;
globalThis.FocusEvent = win.FocusEvent;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.UIEvent = win.UIEvent;
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
globalThis.ResizeObserver = class {
	observe() {}
	unobserve() {}
	disconnect() {}
} as unknown as typeof ResizeObserver;
globalThis.MutationObserver =
	win.MutationObserver as unknown as typeof MutationObserver;
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
	setTimeout(cb, 0)) as unknown as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = ((id: number) =>
	clearTimeout(id)) as unknown as typeof cancelAnimationFrame;

const React = await import("react");
const ReactDOM = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { SessionsSidebar } = await import(
	"~/components/sessions/sessions-sidebar"
);
const { SessionsPage } = await import("~/pages/sessions");
const { ExplorePage } = await import("~/pages/explore");
const { queryKeys } = await import("~/lib/queries");
const { RangeProvider } = await import("~/lib/range");
const { SettingsProvider } = await import("~/lib/settings");

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function click(element: Element | null | undefined) {
	if (!element) throw new Error("Element not found for click");
	element.dispatchEvent(
		new win.MouseEvent("click", { bubbles: true, cancelable: true }),
	);
}

function makeStatusPayload(): StatusPayload {
	return {
		ready: true,
		indexing: false,
		harnesses: [
			{
				harness: "codex",
				available: true,
				records: 10,
				sessions: 12,
				warnings: [],
			},
			{
				harness: "dsh",
				available: true,
				records: 5,
				sessions: 7,
				warnings: [],
			},
			{
				harness: "opencode",
				available: true,
				records: 3,
				sessions: 4,
				warnings: [],
			},
			{
				harness: "commandcode",
				available: false,
				records: 0,
				sessions: 0,
				warnings: [],
			},
			{
				harness: "antigravity",
				available: true,
				records: 8,
				sessions: 9,
				warnings: [],
			},
			{
				harness: "claude",
				available: true,
				records: 20,
				sessions: 15,
				warnings: [],
			},
			{
				harness: "custom-harness",
				available: true,
				records: 4,
				sessions: 6,
				warnings: [],
			},
		],
		lastIndexedAt: Date.now(),
		totalRecords: 50,
		totalSessions: 53,
		totalMessages: 200,
	};
}

describe("Dynamic Harness Filter UI Regression Suite", () => {
	let container: HTMLDivElement;
	let root: ReactDOM.Root;
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
		root = ReactDOM.createRoot(container);
	});

	afterEach(() => {
		root.unmount();
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

		let selectedHarness: string | null = null;
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
							selectedHarness = value;
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
		expect(selectedHarness).toBe("custom-harness");
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
		let postedBatchPayload: Record<string, unknown> | null = null;
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
			if (url.includes("/api/sessions/export")) {
				postedBatchPayload = JSON.parse(String(init?.body ?? "{}")) as Record<
					string,
					unknown
				>;
				return new Response(
					JSON.stringify({
						directory: "/tmp/coding-tokens-exports/export-1",
						indexPath: "/tmp/coding-tokens-exports/export-1/_index.md",
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

		expect(postedBatchPayload).not.toBeNull();
		expect(postedBatchPayload?.keys).toEqual(["claude:c1"]);
		expect(document.body.textContent).toContain(
			"/tmp/coding-tokens-exports/export-1",
		);
	});
});
