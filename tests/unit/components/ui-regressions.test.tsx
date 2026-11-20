import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import type { DetailItem, ModelReportRow } from "@shared/types";
import { GlobalWindow } from "happy-dom";

const DOM_KEYS = [
	"Event",
	"CustomEvent",
	"MouseEvent",
	"PointerEvent",
	"FocusEvent",
	"KeyboardEvent",
	"UIEvent",
	"InputEvent",
	"CompositionEvent",
	"window",
	"document",
	"navigator",
	"HTMLElement",
	"HTMLButtonElement",
	"HTMLInputElement",
	"HTMLFormElement",
	"HTMLDetailsElement",
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
	globalThis.InputEvent = win.InputEvent as unknown as typeof InputEvent;
	globalThis.CompositionEvent =
		win.CompositionEvent as unknown as typeof CompositionEvent;
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
	globalThis.HTMLDetailsElement =
		win.HTMLDetailsElement as unknown as typeof HTMLDetailsElement;
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
const { MemoryRouter } = await import("react-router");
const { QueryClient, QueryClientProvider } = await import(
	"@tanstack/react-query"
);
const { ToolChain } = await import("~/components/tool-chain");
const { ModelPricingDialog } = await import(
	"~/components/pricing/model-pricing-dialog"
);
const { CommandSearch } = await import("~/components/command-search");
const { DetailLevelControl } = await import(
	"~/components/detail-level-control"
);
const { Sparkline } = await import("~/components/charts/sparkline");
const { RangeProvider } = await import("~/lib/range");
const { SettingsProvider } = await import("~/lib/settings");

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

function setInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(
		win.HTMLInputElement.prototype,
		"value",
	)?.set;
	setter?.call(input, value);
	input.dispatchEvent(
		new win.Event("input", { bubbles: true }) as unknown as Event,
	);
}

describe("UI Component Regressions Suite", () => {
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

	function createClient() {
		return new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	}

	test("ToolChain preserves manual expand/collapse state across parent re-renders", async () => {
		const items: DetailItem[] = [
			{
				id: "tool-1",
				order: 1,
				turnId: "t1",
				role: "tool",
				kind: "tool_call",
				phase: "intermediate",
				text: null,
				name: "read_file",
				inputText: '{"path":"README.md"}',
				outputText: null,
				toolCallId: "tc-1",
				category: "read",
				status: null,
				timestamp: 1000,
				durationMs: null,
				truncated: false,
			},
		];

		const queryClient = createClient();
		let triggerRerender: (() => void) | null = null;

		function ParentWrapper() {
			const [tick, setTick] = React.useState(0);
			triggerRerender = () => setTick((n) => n + 1);
			return React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement("div", { "data-tick": String(tick) }),
					React.createElement(ToolChain, {
						items: [...items],
						level: "agent",
					}),
				),
			);
		}

		root.render(React.createElement(ParentWrapper));
		await sleep(40);

		const details = container.querySelector("details") as HTMLDetailsElement;
		expect(details).not.toBeNull();
		expect(details.open).toBe(false);

		// Manually open the <details> disclosure
		details.open = true;
		details.dispatchEvent(
			new win.Event("toggle", { bubbles: false }) as unknown as Event,
		);
		await sleep(30);
		expect(details.open).toBe(true);

		// Re-render parent with same level and fresh items array
		(triggerRerender as (() => void) | null)?.();
		await sleep(40);

		expect(
			(container.querySelector("div[data-tick]") as HTMLElement | null)?.dataset
				.tick,
		).toBe("1");
		expect(details.open).toBe(true);

		// Now manually collapse it and re-render again
		details.open = false;
		details.dispatchEvent(
			new win.Event("toggle", { bubbles: false }) as unknown as Event,
		);
		await sleep(30);
		(triggerRerender as (() => void) | null)?.();
		await sleep(40);
		expect(details.open).toBe(false);
	});

	test("ModelPricingDialog preserves unsaved user edits during background data refetches", async () => {
		const makeRow = (costUsd: number): ModelReportRow => ({
			model: "custom-model-1",
			provider: "custom",
			harnesses: ["codex"],
			lastActivityAt: 1000,
			costPerMillionTokens: null,
			cacheReadShare: 0,
			sparkline: [costUsd],
			totals: {
				sessions: 1,
				messages: 2,
				requests: 1,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				reasoningTokens: 0,
				costUsd,
				estimatedRequests: 0,
				unpricedRequests: 1,
			},
			pricing: {
				source: "unpriced",
				matchedCatalogId: null,
				matchedCatalogName: null,
				effectiveRates: null,
				catalogRates: null,
				customRule: null,
				rawModelIds: ["custom-model-1"],
				estimatedRequests: 0,
				recordedRequests: 0,
				unpricedRequests: 1,
			},
		});

		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ items: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		let updateRow: ((next: ModelReportRow) => void) | null = null;

		function DialogHost() {
			const [row, setRow] = React.useState<ModelReportRow>(() => makeRow(0));
			updateRow = setRow;
			return React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(ModelPricingDialog, {
						open: true,
						onOpenChange: () => {},
						row,
					}),
				),
			);
		}

		root.render(React.createElement(DialogHost));
		await sleep(50);

		// Switch from "Auto" to "Custom rates" mode
		const customModeBtn = Array.from(
			document.body.querySelectorAll("button"),
		).find((b) => b.textContent?.includes("Custom"));
		expect(customModeBtn).toBeDefined();
		click(customModeBtn);
		await sleep(30);

		const inputRateEl = document.body.querySelector(
			"#rate-input",
		) as HTMLInputElement | null;
		expect(inputRateEl).not.toBeNull();
		if (!inputRateEl) throw new Error("Expected #rate-input");
		setInputValue(inputRateEl, "42.5");
		await sleep(20);
		expect(inputRateEl.value).toBe("42.5");

		// Simulate background query refetch supplying a new row object reference
		(updateRow as ((next: ModelReportRow) => void) | null)?.(makeRow(1.25));
		await sleep(40);

		const inputRateAfter = document.body.querySelector(
			"#rate-input",
		) as HTMLInputElement | null;
		expect(inputRateAfter?.value).toBe("42.5");
	});

	test("CommandSearch clears query and composing state when closed via Escape", async () => {
		const searchRequests: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/api/search")) {
				searchRequests.push(url);
				return new Response(
					JSON.stringify({
						sessions: [],
						projects: [],
						models: [],
						harnesses: [],
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return new Response(JSON.stringify({}), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as typeof fetch;

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
					React.createElement(
						MemoryRouter,
						{ initialEntries: ["/"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(CommandSearch),
						),
					),
				),
			),
		);
		await sleep(40);

		// Open CommandSearch
		const trigger = container.querySelector("button");
		expect(trigger).not.toBeNull();
		click(trigger);
		await sleep(50);

		const input = document.body.querySelector(
			"input",
		) as HTMLInputElement | null;
		expect(input).not.toBeNull();
		if (!input) throw new Error("Expected command search input");

		// Start IME composition and enter a query
		input.dispatchEvent(
			new win.CompositionEvent("compositionstart") as unknown as Event,
		);
		setInputValue(input, "draft-ime");
		await sleep(20);
		expect(input.value).toBe("draft-ime");

		// Close dialog with Escape key
		input.dispatchEvent(
			new win.KeyboardEvent("keydown", {
				key: "Escape",
				bubbles: true,
				cancelable: true,
			}) as unknown as Event,
		);
		await sleep(50);

		// Dialog should be closed
		expect(document.body.querySelector("[role='dialog']")).toBeNull();

		// Reopen CommandSearch: query must be cleared and composing must be reset to false
		click(trigger);
		await sleep(50);

		const reopenedInput = document.body.querySelector(
			"input",
		) as HTMLInputElement | null;
		expect(reopenedInput).not.toBeNull();
		expect(reopenedInput?.value).toBe("");

		if (!reopenedInput) throw new Error("Expected reopened input");
		setInputValue(reopenedInput, "alpha");
		await sleep(420);

		expect(searchRequests.some((u) => u.includes("q=alpha"))).toBe(true);
	});

	test("DetailLevelControl displays committed level and does not close popover on Arrow-key stepping", async () => {
		const queryClient = createClient();
		const changes: string[] = [];

		function ControlHost() {
			const [level, setLevel] = React.useState<
				| "user_only"
				| "chat_compact"
				| "chat"
				| "chat_tools"
				| "agent"
				| "agent_full"
			>("chat");
			return React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(DetailLevelControl, {
						level,
						onChange: (next) => {
							changes.push(next);
							setLevel(next);
						},
					}),
				),
			);
		}

		root.render(React.createElement(ControlHost));
		await sleep(40);

		const trigger = container.querySelector("button");
		expect(trigger).not.toBeNull();
		expect(trigger?.textContent).toContain("Chat");

		// Open popover
		click(trigger);
		await sleep(50);

		const sliderThumb = document.body.querySelector(
			"[role='slider']",
		) as HTMLElement | null;
		expect(sliderThumb).not.toBeNull();
		expect(sliderThumb?.getAttribute("aria-valuenow")).toBe("2");

		// Step right with ArrowRight key: slider commits new level via onValueCommit,
		// but popover must stay open!
		sliderThumb?.dispatchEvent(
			new win.KeyboardEvent("keydown", {
				key: "ArrowRight",
				bubbles: true,
				cancelable: true,
			}) as unknown as Event,
		);
		await sleep(50);

		// Popover still mounted (slider still in document)
		const sliderAfter = document.body.querySelector(
			"[role='slider']",
		) as HTMLElement | null;
		expect(sliderAfter).not.toBeNull();
		expect(changes).toEqual(["chat_tools"]);
		expect(trigger?.textContent).toContain("Tools");
	});

	test("Sparkline scales sub-dollar cost values without clamping max to 1", async () => {
		const queryClient = createClient();
		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(Sparkline, {
						values: [0.01, 0.05, 0.02],
					}),
				),
			),
		);
		await sleep(30);

		const polyline = container.querySelector("polyline");
		expect(polyline).not.toBeNull();
		expect(polyline?.getAttribute("points")).toBe("0,17 48,1 96,13");
	});
});
