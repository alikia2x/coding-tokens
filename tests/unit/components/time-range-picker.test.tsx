import { beforeEach, describe, expect, test } from "bun:test";
import { GlobalWindow } from "happy-dom";
import type { DateRange } from "react-day-picker";

// Setup happy-dom environment before importing React and UI components
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
globalThis.Element = win.Element as unknown as typeof Element;
globalThis.Node = win.Node as unknown as typeof Node;
globalThis.NodeFilter = win.NodeFilter as unknown as typeof NodeFilter;
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
const { Calendar } = await import("~/components/ui/calendar");
const { TimeRangePicker } = await import("~/components/time-range-picker");
const { RangeProvider, useRange } = await import("~/lib/range");
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

describe("Date Picker & Calendar Interactive Regression Suite", () => {
	let container: HTMLDivElement;
	let root: ReactDOM.Root;

	beforeEach(() => {
		document.body.innerHTML = "";
		container = document.createElement("div");
		document.body.appendChild(container);
		root = ReactDOM.createRoot(container);
	});

	test("Calendar: mode='range' onSelect fires immediately with DateRange and triggerDate", async () => {
		let firedRange: DateRange | undefined;
		let firedTrigger: Date | null = null;

		function TestCalendar() {
			const [selected, setSelected] = React.useState<DateRange | undefined>(
				undefined,
			);
			return React.createElement(Calendar, {
				mode: "range",
				selected,
				month: new Date(2026, 9, 1), // October 2026
				onSelect: (range: DateRange | undefined, triggerDate: Date) => {
					firedRange = range;
					firedTrigger = triggerDate;
					setSelected(range);
				},
			});
		}

		root.render(React.createElement(TestCalendar));
		await sleep(40);

		const dayButtons = Array.from(
			document.querySelectorAll("button[data-day]"),
		);
		expect(dayButtons.length).toBeGreaterThan(25);

		// Click October 15, 2026
		const btn15 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/15/2026",
		);
		expect(btn15).toBeDefined();
		click(btn15);
		await sleep(40);

		expect(firedTrigger).not.toBeNull();
		expect(firedTrigger?.getDate()).toBe(15);
		expect(firedTrigger?.getMonth()).toBe(9); // October
		expect(firedRange).toBeDefined();
		expect(firedRange?.from).toBeDefined();

		// Re-query day buttons after first click and re-render
		const dayButtonsAfter = Array.from(
			document.querySelectorAll("button[data-day]"),
		);
		const btn22 = dayButtonsAfter.find(
			(b) => b.getAttribute("data-day") === "10/22/2026",
		);
		expect(btn22).toBeDefined();
		click(btn22);
		await sleep(40);

		expect(firedTrigger?.getDate()).toBe(22);
		expect(firedRange?.from).toBeDefined();
		expect(firedRange?.to).toBeDefined();
		expect(firedRange?.to.getDate()).toBe(22);
	});

	test("Calendar: range modifiers highlight start, middle, and end dates accurately", async () => {
		const from = new Date(2026, 9, 10);
		const to = new Date(2026, 9, 15);

		root.render(
			React.createElement(Calendar, {
				mode: "range",
				selected: { from, to },
				month: new Date(2026, 9, 1),
			}),
		);
		await sleep(40);

		const dayButtons = Array.from(
			document.querySelectorAll("button[data-day]"),
		);
		const btnStart = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/10/2026",
		);
		const btnMiddle = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/12/2026",
		);
		const btnEnd = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/15/2026",
		);
		const btnOutside = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/5/2026",
		);

		expect(btnStart?.getAttribute("data-range-start")).toBe("true");
		expect(btnMiddle?.getAttribute("data-range-middle")).toBe("true");
		expect(btnEnd?.getAttribute("data-range-end")).toBe("true");
		expect(btnOutside?.getAttribute("data-range-start")).toBe("false");
		expect(btnOutside?.getAttribute("data-range-middle")).toBe("false");
	});

	test("Calendar: single day selected renders data-selected-single='true'", async () => {
		const from = new Date(2026, 9, 10);

		root.render(
			React.createElement(Calendar, {
				mode: "range",
				selected: { from, to: undefined },
				month: new Date(2026, 9, 1),
			}),
		);
		await sleep(40);

		const dayButtons = Array.from(
			document.querySelectorAll("button[data-day]"),
		);
		const btn10 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/10/2026",
		);
		const btn11 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/11/2026",
		);

		expect(btn10?.getAttribute("data-selected-single")).toBe("true");
		expect(btn11?.getAttribute("data-selected-single")).not.toBe("true");
	});

	test("TimeRangePicker: clicking start then end date selects custom range, applies, and updates state", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let capturedRange: ReturnType<typeof useRange> | null = null;

		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(
						MemoryRouter,
						{ initialEntries: ["/?range=30d"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(TimeRangePicker, null),
							React.createElement(RangeProbe, null),
						),
					),
				),
			),
		);
		await sleep(40);

		expect(capturedRange?.key).toBe("30d");

		// Open the Popover
		const trigger = document.querySelector("[data-range-picker]");
		expect(trigger).not.toBeNull();
		click(trigger);
		await sleep(50);

		// Find day buttons
		let dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		expect(dayButtons.length).toBeGreaterThan(0);

		// Click Day 1: October 10, 2026
		const day1 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/10/2026",
		);
		expect(day1).toBeDefined();
		click(day1);
		await sleep(50);

		// Re-query day buttons to verify visual highlight on first click
		dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		const updatedDay1 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/10/2026",
		);
		expect(updatedDay1?.getAttribute("data-selected-single")).toBe("true");

		// Apply button is enabled for open-ended start-only range
		const buttons = Array.from(document.querySelectorAll("button"));
		const applyBtnBefore = buttons.find(
			(b) => b.textContent?.trim() === "Apply",
		);
		expect(applyBtnBefore?.disabled).toBe(false);

		// Click Day 2: October 20, 2026
		const day2 = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/20/2026",
		);
		expect(day2).toBeDefined();
		click(day2);
		await sleep(50);

		// Re-query to verify range selection highlights
		dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		const bStart = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/10/2026",
		);
		const bMid = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/15/2026",
		);
		const bEnd = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/20/2026",
		);

		expect(bStart?.getAttribute("data-range-start")).toBe("true");
		expect(bMid?.getAttribute("data-range-middle")).toBe("true");
		expect(bEnd?.getAttribute("data-range-end")).toBe("true");

		// Apply button should now be enabled
		const allButtons = Array.from(document.querySelectorAll("button"));
		const applyBtnAfter = allButtons.find(
			(b) => b.textContent?.trim() === "Apply",
		);
		expect(applyBtnAfter?.disabled).toBe(false);

		// Click Apply
		click(applyBtnAfter);
		await sleep(60);

		expect(capturedRange?.key).toBe("custom");
		expect(capturedRange?.from).toBeDefined();
		expect(capturedRange?.until).toBeDefined();

		const fromDate = new Date(capturedRange.from);
		const toDate = new Date(capturedRange.until - 1);
		expect(fromDate.getDate()).toBe(10);
		expect(fromDate.getMonth()).toBe(9); // October
		expect(toDate.getDate()).toBe(20);
		expect(toDate.getMonth()).toBe(9);
	});

	test("TimeRangePicker: clicking end before start auto-swaps endpoints safely", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let capturedRange: ReturnType<typeof useRange> | null = null;

		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(
						MemoryRouter,
						{ initialEntries: ["/?range=30d"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(TimeRangePicker, null),
							React.createElement(RangeProbe, null),
						),
					),
				),
			),
		);
		await sleep(40);

		// Open popover
		const trigger = document.querySelector("[data-range-picker]");
		click(trigger);
		await sleep(50);

		let dayButtons = Array.from(document.querySelectorAll("button[data-day]"));

		// First click later date: October 20
		const btnLater = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/20/2026",
		);
		click(btnLater);
		await sleep(50);

		// Second click earlier date: October 5 (clicked < fromDate)
		dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		const btnEarlier = dayButtons.find(
			(b) =>
				b.getAttribute("data-day") === "10/05/2026" ||
				b.getAttribute("data-day") === "10/5/2026",
		);
		click(btnEarlier);
		await sleep(50);

		// Apply button should be enabled and dates swapped
		const applyBtn = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		);
		expect(applyBtn?.disabled).toBe(false);
		click(applyBtn);
		await sleep(60);

		expect(capturedRange?.key).toBe("custom");
		const fromDate = new Date(capturedRange.from);
		const toDate = new Date(capturedRange.until - 1);
		expect(fromDate.getDate()).toBe(5);
		expect(toDate.getDate()).toBe(20);
		expect(fromDate.getTime()).toBeLessThan(toDate.getTime());
	});

	test("TimeRangePicker: clicking the same day twice creates a single-day range", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let capturedRange: ReturnType<typeof useRange> | null = null;

		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(
						MemoryRouter,
						{ initialEntries: ["/?range=30d"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(TimeRangePicker, null),
							React.createElement(RangeProbe, null),
						),
					),
				),
			),
		);
		await sleep(40);

		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		let dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		const btn = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/15/2026",
		);

		// Click 1
		click(btn);
		await sleep(50);

		// Click 2 on same day
		dayButtons = Array.from(document.querySelectorAll("button[data-day]"));
		const btnSame = dayButtons.find(
			(b) => b.getAttribute("data-day") === "10/15/2026",
		);
		click(btnSame);
		await sleep(50);

		const applyBtn = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		);
		expect(applyBtn?.disabled).toBe(false);
		click(applyBtn);
		await sleep(60);

		expect(capturedRange?.key).toBe("custom");
		const fromDate = new Date(capturedRange.from);
		const toDate = new Date(capturedRange.until - 1);
		expect(fromDate.getDate()).toBe(15);
		expect(toDate.getDate()).toBe(15);
		// Span should be full day 23:59:00
		expect(toDate.getHours()).toBe(23);
		expect(toDate.getMinutes()).toBe(59);
	});

	test("TimeRangePicker: clicking presets immediately updates range and closes popover", async () => {
		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		let capturedRange: ReturnType<typeof useRange> | null = null;

		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}

		root.render(
			React.createElement(
				QueryClientProvider,
				{ client: queryClient },
				React.createElement(
					SettingsProvider,
					null,
					React.createElement(
						MemoryRouter,
						{ initialEntries: ["/?range=30d"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(TimeRangePicker, null),
							React.createElement(RangeProbe, null),
						),
					),
				),
			),
		);
		await sleep(40);

		// Open popover
		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		// Find preset buttons in sidebar aside
		const asideButtons = Array.from(document.querySelectorAll("aside button"));
		expect(asideButtons.length).toBeGreaterThan(3);

		// Click "Last 7 days"
		const preset7d = asideButtons.find((b) =>
			b.textContent?.includes("7 days"),
		);
		expect(preset7d).toBeDefined();
		click(preset7d);
		await sleep(60);

		expect(capturedRange?.key).toBe("7d");

		// Open popover again and click "All time"
		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		const asideButtons2 = Array.from(document.querySelectorAll("aside button"));
		const presetAll = asideButtons2.find((b) =>
			b.textContent?.includes("All time"),
		);
		expect(presetAll).toBeDefined();
		click(presetAll);
		await sleep(60);

		expect(capturedRange?.key).toBe("all");
	});

	test("TimeRangePicker: Reset button resets draft to default settings fallback", async () => {
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
						{
							initialEntries: [
								"/?range=custom&from=2026-01-01T00:00&to=2026-01-05T00:00",
							],
						},
						React.createElement(
							RangeProvider,
							null,
							React.createElement(TimeRangePicker, null),
						),
					),
				),
			),
		);
		await sleep(40);

		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		const resetButton = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.includes("Reset"),
		);
		expect(resetButton).toBeDefined();
		click(resetButton);
		await sleep(50);

		// Start and End fields should now show the default 30d range
		const endpointButtons = Array.from(
			document.querySelectorAll("button[data-endpoint]"),
		);
		expect(endpointButtons.length).toBe(2);
		expect(endpointButtons[0]?.textContent).not.toContain("2026/01/01");
	});

	test("TimeRangePicker: allows start-only open-ended custom range", async () => {
		let capturedRange: {
			key: string;
			from: number | null;
			until: number | null;
		} | null = null;
		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}
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
						{ initialEntries: ["/?range=all"] },
						React.createElement(
							RangeProvider,
							null,
							React.createElement(RangeProbe, null),
							React.createElement(TimeRangePicker, null),
						),
					),
				),
			),
		);
		await sleep(40);

		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		const dayButtons = Array.from(
			document.querySelectorAll("button[data-day]"),
		);
		const day10 = dayButtons.find((b) => b.textContent?.trim() === "10");
		expect(day10).toBeDefined();
		click(day10);
		await sleep(40);

		const applyButton = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		) as HTMLButtonElement | undefined;
		expect(applyButton).toBeDefined();
		expect(applyButton?.disabled).toBe(false);
		click(applyButton);
		await sleep(60);

		expect(capturedRange?.key).toBe("custom");
		expect(capturedRange?.from).not.toBeNull();
		expect(capturedRange?.until).toBeNull();
	});

	test("TimeRangePicker: allows clearing start endpoint for end-only open-ended custom range", async () => {
		let capturedRange: {
			key: string;
			from: number | null;
			until: number | null;
		} | null = null;
		function RangeProbe() {
			const { range } = useRange();
			capturedRange = range;
			return null;
		}
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
						{
							initialEntries: [
								"/?range=custom&from=2026-01-01T00:00&to=2026-01-05T00:00",
							],
						},
						React.createElement(
							RangeProvider,
							null,
							React.createElement(RangeProbe, null),
							React.createElement(TimeRangePicker, null),
						),
					),
				),
			),
		);
		await sleep(40);

		click(document.querySelector("[data-range-picker]"));
		await sleep(50);

		const clearStart = document.querySelector(
			'button[data-clear-endpoint="start"]',
		);
		expect(clearStart).toBeDefined();
		click(clearStart);
		await sleep(40);

		const applyButton = Array.from(document.querySelectorAll("button")).find(
			(b) => b.textContent?.trim() === "Apply",
		) as HTMLButtonElement | undefined;
		expect(applyButton?.disabled).toBe(false);
		click(applyButton);
		await sleep(60);

		expect(capturedRange?.key).toBe("custom");
		expect(capturedRange?.from).toBeNull();
		expect(capturedRange?.until).not.toBeNull();
	});
});
