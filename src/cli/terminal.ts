import { defaultPlatformPathService } from "../platform/paths";

export interface Style {
	enabled: boolean;
	bold: (text: string) => string;
	dim: (text: string) => string;
	cyan: (text: string) => string;
	green: (text: string) => string;
	yellow: (text: string) => string;
	red: (text: string) => string;
	blue: (text: string) => string;
	magenta: (text: string) => string;
}

export function createStyle(options: { noColor?: boolean } = {}): Style {
	const forceColor = process.env.FORCE_COLOR;
	const noColorEnv = process.env.NO_COLOR;
	const enabled =
		!options.noColor &&
		noColorEnv === undefined &&
		(forceColor ? forceColor !== "0" : Boolean(process.stdout.isTTY));

	const wrap = (open: string, close: string) => (text: string) =>
		enabled ? `\x1b[${open}m${text}\x1b[${close}m` : text;

	return {
		enabled,
		bold: wrap("1", "22"),
		dim: wrap("2", "22"),
		cyan: wrap("36", "39"),
		green: wrap("32", "39"),
		yellow: wrap("33", "39"),
		red: wrap("31", "39"),
		blue: wrap("34", "39"),
		magenta: wrap("35", "39"),
	};
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");

export function stripAnsi(text: string): string {
	return text.replaceAll(ANSI_PATTERN, "");
}

function isWideCodePoint(cp: number): boolean {
	return (
		(cp >= 0x1100 && cp <= 0x115f) ||
		cp === 0x2329 ||
		cp === 0x232a ||
		(cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
		(cp >= 0xac00 && cp <= 0xd7a3) ||
		(cp >= 0xf900 && cp <= 0xfaff) ||
		(cp >= 0xfe10 && cp <= 0xfe19) ||
		(cp >= 0xfe30 && cp <= 0xfe6f) ||
		(cp >= 0xff00 && cp <= 0xff60) ||
		(cp >= 0xffe0 && cp <= 0xffe6) ||
		(cp >= 0x1f300 && cp <= 0x1f64f) ||
		(cp >= 0x1f900 && cp <= 0x1f9ff) ||
		(cp >= 0x20000 && cp <= 0x2fffd) ||
		(cp >= 0x30000 && cp <= 0x3fffd)
	);
}

export function displayWidth(text: string): number {
	const plain = stripAnsi(text);
	let width = 0;
	for (const ch of plain) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
		width += isWideCodePoint(cp) ? 2 : 1;
	}
	return width;
}

export function truncateText(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const plain = stripAnsi(text);
	if (displayWidth(plain) <= maxWidth) return text;
	if (maxWidth === 1) return "…";
	let width = 0;
	let out = "";
	for (const ch of plain) {
		const cp = ch.codePointAt(0);
		if (cp === undefined) continue;
		const charWidth =
			cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)
				? 0
				: isWideCodePoint(cp)
					? 2
					: 1;
		if (width + charWidth + 1 > maxWidth) break;
		out += ch;
		width += charWidth;
	}
	return `${out}…`;
}

function padCell(
	text: string,
	width: number,
	align: "left" | "right" = "left",
): string {
	const w = displayWidth(text);
	if (w >= width) return text;
	const pad = " ".repeat(width - w);
	return align === "right" ? `${pad}${text}` : `${text}${pad}`;
}

export interface TableColumn {
	key: string;
	header: string;
	align?: "left" | "right";
	minWidth?: number;
	maxWidth?: number;
	shrinkPriority?: number;
}

export function renderTable(options: {
	columns: TableColumn[];
	rows: Array<Record<string, string>>;
	footerRow?: Record<string, string>;
	style: Style;
	maxWidth?: number;
}): string {
	const { columns, rows, footerRow, style } = options;
	const terminalWidth =
		options.maxWidth ??
		(process.stdout.isTTY && process.stdout.columns
			? Math.max(60, process.stdout.columns)
			: 112);

	const widths = columns.map((col) => {
		let max = displayWidth(col.header);
		for (const row of rows) {
			max = Math.max(max, displayWidth(row[col.key] ?? ""));
		}
		if (footerRow) {
			max = Math.max(max, displayWidth(footerRow[col.key] ?? ""));
		}
		if (col.maxWidth !== undefined) max = Math.min(max, col.maxWidth);
		if (col.minWidth !== undefined) max = Math.max(max, col.minWidth);
		return max;
	});

	const gap = 2;
	const totalGaps = Math.max(0, columns.length - 1) * gap;
	const totalWidth = () => widths.reduce((sum, w) => sum + w, 0) + totalGaps;

	// Shrink columns with shrinkPriority > 0 (highest priority shrinks first)
	if (totalWidth() > terminalWidth) {
		const shrinkOrder = columns
			.map((col, idx) => ({
				idx,
				priority: col.shrinkPriority ?? 0,
				minWidth: col.minWidth ?? 8,
			}))
			.filter((entry) => entry.priority > 0)
			.sort((a, b) => b.priority - a.priority);

		let overflow = totalWidth() - terminalWidth;
		for (const entry of shrinkOrder) {
			if (overflow <= 0) break;
			const current = widths[entry.idx] ?? 0;
			const canShrink = Math.max(0, current - entry.minWidth);
			if (canShrink === 0) continue;
			const delta = Math.min(overflow, canShrink);
			widths[entry.idx] = current - delta;
			overflow -= delta;
		}
	}

	const formatLine = (
		record: Record<string, string>,
		isHeader = false,
		isFooter = false,
	): string => {
		const parts = columns.map((col, idx) => {
			const width = widths[idx] ?? 8;
			const raw = record[col.key] ?? "";
			const clipped =
				displayWidth(raw) > width ? truncateText(raw, width) : raw;
			const padded = padCell(clipped, width, col.align ?? "left");
			if (isHeader) return style.bold(style.dim(padded));
			if (isFooter) return style.bold(padded);
			return padded;
		});
		return parts.join("  ");
	};

	const headerRecord = Object.fromEntries(
		columns.map((col) => [col.key, col.header]),
	);
	const ruleWidth = Math.min(terminalWidth, Math.max(20, totalWidth()));
	const divider = style.dim("-".repeat(ruleWidth));

	const lines = [formatLine(headerRecord, true, false), divider];
	for (const row of rows) {
		lines.push(formatLine(row, false, false));
	}
	if (footerRow) {
		lines.push(divider);
		lines.push(formatLine(footerRow, false, true));
	}
	return lines.join("\n");
}

export interface Spinner {
	start: (text: string) => void;
	update: (text: string) => void;
	stop: () => void;
}

const SPINNER_FRAMES = ["-", "\\", "|", "/"];

export function createSpinner(options: {
	quiet?: boolean;
	json?: boolean;
	noColor?: boolean;
}): Spinner {
	const active =
		!options.quiet && !options.json && Boolean(process.stderr.isTTY);
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;
	let message = "";

	const render = () => {
		if (!active) return;
		const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length] ?? "-";
		frameIndex += 1;
		process.stderr.write(`\r\x1b[2K${frame} ${message}`);
	};

	return {
		start(text: string) {
			if (!active) return;
			message = text;
			render();
			if (!timer) {
				timer = setInterval(render, 90);
			}
		},
		update(text: string) {
			if (!active) return;
			message = text;
			render();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
			if (active) {
				process.stderr.write("\r\x1b[2K");
			}
		},
	};
}

const intFormat = new Intl.NumberFormat("en-US");
const costFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	minimumFractionDigits: 2,
	maximumFractionDigits: 4,
});
const exactCostFormat = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 8,
});

export function formatNumber(value: number): string {
	return intFormat.format(value);
}

export function formatTokens(value: number, exact = false): string {
	if (exact || value < 1_000) return intFormat.format(value);
	if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}K`;
	if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
	return `${(value / 1_000_000_000).toFixed(2)}B`;
}

export function formatCost(
	costUsd: number,
	estimated: boolean,
	allUnpriced: boolean,
	exact = false,
): string {
	if (allUnpriced) return "-";
	const prefix = estimated ? "~" : "";
	const formatter = exact ? exactCostFormat : costFormat;
	return `${prefix}${formatter.format(costUsd)}`;
}

export function formatPercent(ratio: number | null): string {
	if (ratio === null || !Number.isFinite(ratio)) return "-";
	return `${(ratio * 100).toFixed(1)}%`;
}

export function formatDuration(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return "-";
	if (ms < 1_000) return `${Math.round(ms)}ms`;
	const sec = ms / 1_000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const mins = Math.floor(sec / 60);
	const remSec = Math.round(sec % 60);
	if (mins < 60) return `${mins}m ${remSec}s`;
	const hours = Math.floor(mins / 60);
	const remMin = mins % 60;
	return `${hours}h ${remMin}m`;
}

export function formatTimestamp(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "-";
	const date = new Date(ms);
	if (Number.isNaN(date.valueOf())) return "-";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRelativeTime(ms: number | null): string {
	if (ms === null || !Number.isFinite(ms)) return "-";
	const diff = Date.now() - ms;
	if (diff < 60_000) return "just now";
	const mins = Math.floor(diff / 60_000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.floor(mins / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return formatTimestamp(ms).slice(0, 10);
}

export function shortenHome(filePath: string | null): string {
	if (!filePath) return "Unknown project";
	const home = defaultPlatformPathService.getHomeDir();
	if (filePath === home) return "~";
	if (filePath.startsWith(`${home}/`)) return `~${filePath.slice(home.length)}`;
	return filePath;
}
