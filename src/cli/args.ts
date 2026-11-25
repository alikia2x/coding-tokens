import pkg from "../../package.json";
import { defaultPlatformPathService } from "../platform/paths";
import { defaultHarnessRegistry } from "../providers/registry";

export const CLI_NAME = "coding-tokens";
export const CLI_VERSION = pkg.version;

export const EXPORT_DETAIL_LEVELS = [
	"user_only",
	"chat_compact",
	"chat",
	"chat_tools",
	"agent",
	"agent_full",
] as const;

export const BATCH_ORGANIZATIONS = [
	"flat",
	"harness",
	"date",
	"project",
	"custom",
] as const;

export const RANGE_PRESET_NAMES = [
	"today",
	"yesterday",
	"7d",
	"30d",
	"90d",
	"1y",
	"all",
] as const;

export const HARNESS_ENV_VARS: Record<string, string[]> = {
	codex: ["CODEX_HOME"],
	dsh: ["DSH_HOME"],
	opencode: ["OPENCODE_DATA_DIR", "OPENCODE_DB"],
	commandcode: ["COMMANDCODE_HOME"],
	antigravity: ["ANTIGRAVITY_HOME", "T3_USER_DATA_DIR"],
	claude: ["CLAUDE_CONFIG_DIR"],
	aider: ["AIDER_HOME"],
	openhands: ["OPENHANDS_DIR", "OPENHANDS_CONVERSATIONS_DIR"],
	goose: ["GOOSE_PATH_ROOT"],
};

export class CliUsageError extends Error {
	readonly suggestion?: string;
	readonly hint?: string;

	constructor(
		message: string,
		options?: { suggestion?: string; hint?: string },
	) {
		super(message);
		this.name = "CliUsageError";
		this.suggestion = options?.suggestion;
		this.hint = options?.hint;
	}
}

export function allHarnessIds(): string[] {
	return defaultHarnessRegistry.getAll().map((p) => p.metadata.id);
}

export function getHarnessLabel(id: string): string {
	return defaultHarnessRegistry.get(id)?.metadata.displayName ?? id;
}

function levenshtein(a: string, b: string): number {
	const m = a.length;
	const n = b.length;
	const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
	for (let i = 1; i <= m; i += 1) {
		let prev = dp[0] ?? 0;
		dp[0] = i;
		for (let j = 1; j <= n; j += 1) {
			const temp = dp[j] ?? 0;
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + cost);
			prev = temp;
		}
	}
	return dp[n] ?? 0;
}

export function suggestClosest(
	input: string,
	candidates: readonly string[],
): string | null {
	const target = input.trim().toLowerCase();
	if (!target) return null;
	let best: string | null = null;
	let bestDist = Number.POSITIVE_INFINITY;
	const maxDist = Math.min(3, Math.ceil(target.length / 2));

	for (const candidate of candidates) {
		const lower = candidate.toLowerCase();
		if (lower.startsWith(target) || target.startsWith(lower)) {
			return candidate;
		}
		const dist = levenshtein(target, lower);
		if (dist < bestDist && dist <= maxDist) {
			bestDist = dist;
			best = candidate;
		}
	}
	return best;
}

export function parseList<T extends string>(
	value: string | undefined,
	allowed: readonly T[],
	flag: string,
): T[] | undefined {
	if (value === undefined) return undefined;
	const values = [
		...new Set(
			value
				.split(",")
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	if (values.length === 0) {
		throw new CliUsageError(`${flag} accepts: ${allowed.join(", ")}`);
	}
	const invalid = values.filter((item) => !allowed.includes(item as T));
	if (invalid.length > 0) {
		const firstInvalid = invalid[0] ?? "";
		const closest = suggestClosest(firstInvalid, allowed);
		throw new CliUsageError(`${flag} accepts: ${allowed.join(", ")}`, {
			suggestion: closest ? `Did you mean "${closest}"?` : undefined,
		});
	}
	return values as T[];
}

export function parseMultiList(
	values: string[] | undefined,
): string[] | undefined {
	if (!values?.length) return undefined;
	const items = [
		...new Set(
			values
				.flatMap((entry) => entry.split(","))
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];
	return items.length ? items : undefined;
}

export function parseDate(
	value: string | undefined,
	flag: string,
): string | undefined {
	if (value === undefined) return undefined;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	if (
		!/^\d{4}-\d{2}-\d{2}$/u.test(value) ||
		Number.isNaN(parsed.valueOf()) ||
		parsed.toISOString().slice(0, 10) !== value
	) {
		throw new CliUsageError(`${flag} must be a valid YYYY-MM-DD date`, {
			hint: `Example: ${flag} 2026-03-15`,
		});
	}
	return value;
}

export interface TimeBound {
	text: string;
	ms: number;
}

const dateTimePattern =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/u;

function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseTimeBound(
	value: string | undefined,
	flag: string,
	isEnd: boolean,
): TimeBound | undefined {
	if (value === undefined) return undefined;
	const match = dateTimePattern.exec(value.trim());
	if (!match) {
		throw new CliUsageError(
			`${flag} must be YYYY-MM-DD, YYYY-MM-DD HH:MM, or YYYY-MM-DD HH:MM:SS`,
			{ hint: `Example: ${flag} 2026-03-01` },
		);
	}
	const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
		match;
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hasTime = hourText !== undefined;
	const hasSeconds = secondText !== undefined;
	const hour = hasTime ? Number(hourText) : 0;
	const minute = hasTime ? Number(minuteText) : 0;
	const second = hasSeconds ? Number(secondText) : 0;
	if (
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > daysInMonth(year, month) ||
		hour > 23 ||
		minute > 59 ||
		second > 59
	) {
		throw new CliUsageError(
			`${flag} is not a valid local date and time: ${value.trim()}`,
		);
	}
	let ms = new Date(year, month - 1, day, hour, minute, second, 0).valueOf();
	if (isEnd) {
		if (hasSeconds) {
			ms = new Date(
				year,
				month - 1,
				day,
				hour,
				minute,
				second + 1,
				0,
			).valueOf();
		} else if (hasTime) {
			ms = new Date(year, month - 1, day, hour, minute + 1, 0, 0).valueOf();
		} else {
			ms = new Date(year, month - 1, day + 1, 0, 0, 0, 0).valueOf();
		}
	}
	const text = hasTime
		? `${yearText}-${monthText}-${dayText} ${hourText}:${minuteText}${hasSeconds ? `:${secondText}` : ""}`
		: `${yearText}-${monthText}-${dayText}`;
	return { text, ms };
}

export interface ParsedRange {
	label: string;
	sinceMs: number | null;
	untilMs: number | null;
}

export function parseRangePreset(
	value: string | undefined,
): ParsedRange | undefined {
	if (value === undefined) return undefined;
	const raw = value.trim().toLowerCase();
	const now = new Date();
	const todayStart = new Date(
		now.getFullYear(),
		now.getMonth(),
		now.getDate(),
		0,
		0,
		0,
		0,
	).valueOf();

	if (raw === "all") {
		return { label: "all", sinceMs: null, untilMs: null };
	}
	if (raw === "today") {
		return { label: "today", sinceMs: todayStart, untilMs: null };
	}
	if (raw === "yesterday") {
		const yStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() - 1,
			0,
			0,
			0,
			0,
		).valueOf();
		return { label: "yesterday", sinceMs: yStart, untilMs: todayStart };
	}
	if (raw === "1y") {
		return {
			label: "1y",
			sinceMs: Date.now() - 365 * 24 * 60 * 60 * 1000,
			untilMs: null,
		};
	}

	const durationMatch = /^(\d+)([hdw])$/u.exec(raw);
	if (durationMatch) {
		const amount = Number(durationMatch[1]);
		const unit = durationMatch[2];
		if (amount > 0) {
			const unitMs =
				unit === "h"
					? 60 * 60 * 1000
					: unit === "w"
						? 7 * 24 * 60 * 60 * 1000
						: 24 * 60 * 60 * 1000;
			return {
				label: raw,
				sinceMs: Date.now() - amount * unitMs,
				untilMs: null,
			};
		}
	}

	const closest = suggestClosest(raw, RANGE_PRESET_NAMES);
	throw new CliUsageError(
		`--range accepts: today, yesterday, 7d, 30d, 90d, 1y, all, or <N>h / <N>d / <N>w`,
		{
			suggestion: closest ? `Did you mean "${closest}"?` : undefined,
			hint: "Example: --range 7d",
		},
	);
}

export function resolveTimeWindow(input: {
	date?: string;
	since?: string;
	until?: string;
	range?: string;
}): {
	date?: string;
	since?: TimeBound;
	until?: TimeBound;
	range?: ParsedRange;
	fromMs: number | null;
	untilMs: number | null;
} {
	const date = parseDate(input.date, "--date");
	const since = parseTimeBound(input.since, "--since", false);
	const until = parseTimeBound(input.until, "--until", true);
	const range = parseRangePreset(input.range);

	if (date && (since || until)) {
		throw new CliUsageError(
			"--date cannot be combined with --since or --until",
		);
	}
	if (range && (date || since || until)) {
		throw new CliUsageError(
			"--range cannot be combined with --date, --since, or --until",
		);
	}
	if (since && until && since.ms >= until.ms) {
		throw new CliUsageError("--since must be earlier than --until");
	}

	let fromMs: number | null = since?.ms ?? range?.sinceMs ?? null;
	let untilMs: number | null = until?.ms ?? range?.untilMs ?? null;
	if (date) {
		const [y, m, d] = date.split("-").map(Number);
		if (y && m && d) {
			fromMs = new Date(y, m - 1, d, 0, 0, 0, 0).valueOf();
			untilMs = new Date(y, m - 1, d + 1, 0, 0, 0, 0).valueOf();
		}
	}

	return { date, since, until, range, fromMs, untilMs };
}

export function parsePositiveInt(
	value: string | undefined,
	flag: string,
): number | undefined {
	if (value === undefined) return undefined;
	const num = Number(value);
	if (!Number.isInteger(num) || num <= 0) {
		throw new CliUsageError(`${flag} must be a positive integer`);
	}
	return num;
}

export function resolveProjectPaths(
	projects: string[] | undefined,
): string[] | undefined {
	if (!projects?.length) return undefined;
	return projects.map((project) =>
		defaultPlatformPathService.normalize(
			defaultPlatformPathService.expandPath(project),
		),
	);
}
