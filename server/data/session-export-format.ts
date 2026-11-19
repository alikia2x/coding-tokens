import type {
	BatchExportOrganization,
	SessionDetailLevel,
	UsageRecord,
} from "@shared/types";
import { renderSessionMarkdown } from "../../src/exporter";
import type { TranscriptSession } from "../../src/types";
import { cleanSessionTitle, type SessionMeta } from "./catalog";

export interface ExportWorkerItem {
	key: string;
	meta: SessionMeta;
	records: UsageRecord[];
}

export interface ExportWorkerRequest {
	items: ExportWorkerItem[];
	detail: SessionDetailLevel;
	includeTimestamps: boolean;
	includeTokenStats: boolean;
	organization: BatchExportOrganization;
	pathTemplate?: string;
}

export type ExportWorkerEvent =
	| {
			type: "item";
			key: string;
			rawRelative: string;
			content: string;
			currentTitle?: string;
	  }
	| {
			type: "miss";
			key: string;
			warning: string;
			currentTitle?: string;
	  };

export function exportProjectName(cwd: string | null): string {
	if (!cwd) return "Unknown project";
	const normalized = cwd.replace(/\/+$/u, "");
	const name = normalized.split("/").at(-1);
	return name || normalized;
}

export function safeFilename(value: string): string {
	const normalized = value
		.normalize("NFKD")
		.replaceAll(/[<>:"/\\|?*\p{Cc}]+/gu, "-")
		.replaceAll(/[^\p{L}\p{N}._-]+/gu, "-")
		.replaceAll(/-+/gu, "-")
		.replaceAll(/^-+|-+$/gu, "")
		.slice(0, 72);
	return normalized || "session";
}

export function uniqueRelativePath(
	usedPaths: Set<string>,
	rawRelative: string,
): string {
	const cleaned = rawRelative.replace(/\.md$/iu, "");
	let candidate = `${cleaned}.md`;
	let index = 2;
	while (usedPaths.has(candidate)) {
		candidate = `${cleaned}-${index}.md`;
		index += 1;
	}
	usedPaths.add(candidate);
	return candidate;
}

export function sanitizeSegment(value: string, fallback = "item"): string {
	const cleaned = value
		.normalize("NFKD")
		.replaceAll(/[<>:"|?*\\/\p{Cc}]+/gu, "-")
		.replaceAll(/\.+/gu, ".")
		.replaceAll(/-+/gu, "-")
		.replaceAll(/^[-.]+|[-.]+$/gu, "")
		.slice(0, 72);
	if (!cleaned || cleaned === "." || cleaned === "..") return fallback;
	return cleaned;
}

export function formatTemplateRelativePath(
	organization: BatchExportOrganization,
	pathTemplate: string | undefined,
	tokens: {
		harness: string;
		project: string;
		year: string;
		month: string;
		day: string;
		date: string;
		title: string;
		id: string;
	},
): string {
	let template = "{title}-{id}.md";
	if (organization === "harness") {
		template = "{harness}/{title}-{id}.md";
	} else if (organization === "date") {
		template = "{year}/{month}/{day}/{title}-{id}.md";
	} else if (organization === "project") {
		template = "{project}/{title}-{id}.md";
	} else if (organization === "custom" && pathTemplate?.trim()) {
		template = pathTemplate.trim();
	}

	const replaced = template
		.replaceAll("{harness}", tokens.harness)
		.replaceAll("{project}", tokens.project)
		.replaceAll("{year}", tokens.year)
		.replaceAll("{month}", tokens.month)
		.replaceAll("{day}", tokens.day)
		.replaceAll("{date}", tokens.date)
		.replaceAll("{title}", tokens.title)
		.replaceAll("{id}", tokens.id);

	const segments = replaced
		.split(/[/\\]+/u)
		.map((part) => part.trim())
		.filter((part) => part && part !== "." && part !== "..")
		.map((part, index, list) =>
			index === list.length - 1
				? sanitizeSegment(part.replace(/\.md$/iu, ""), "session")
				: sanitizeSegment(part, "unknown"),
		);

	return segments.length
		? `${segments.join("/")}.md`
		: `${tokens.title}-${tokens.id}.md`;
}

export function resolveExportTitle(
	metaTitle: string,
	rawTitle: string | undefined,
	harness: Parameters<typeof cleanSessionTitle>[1],
): string {
	const raw =
		metaTitle && metaTitle !== "Untitled session"
			? metaTitle
			: (rawTitle ?? metaTitle);
	return cleanSessionTitle(raw, harness);
}

/** Format a parsed transcript session into a relative export path and markdown body. */
export function renderExportSessionItem(
	item: ExportWorkerItem,
	session: TranscriptSession,
	options: {
		detail: SessionDetailLevel;
		includeTimestamps: boolean;
		includeTokenStats: boolean;
		organization: BatchExportOrganization;
		pathTemplate?: string;
	},
): { rawRelative: string; content: string | null; currentTitle: string } {
	session.usageRecords = item.records;
	session.title = resolveExportTitle(
		item.meta.title,
		session.title,
		session.harness,
	);
	const currentTitle = session.title.replace(/\s+/gu, " ").trim().slice(0, 80);
	const markdown = renderSessionMarkdown(session, {
		detail: options.detail,
		includeTimestamps: options.includeTimestamps,
		includeTokenStats: options.includeTokenStats,
	});
	if (!markdown) {
		return { rawRelative: "", content: null, currentTitle };
	}
	const ts =
		item.records.at(-1)?.timestamp ??
		item.meta.startedAt ??
		session.startedAt ??
		Date.now();
	const dt = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	const year = String(dt.getFullYear());
	const month = pad(dt.getMonth() + 1);
	const day = pad(dt.getDate());
	const rawRelative = formatTemplateRelativePath(
		options.organization,
		options.pathTemplate,
		{
			harness: sanitizeSegment(item.meta.harness, "harness"),
			project: sanitizeSegment(
				exportProjectName(item.meta.cwd),
				"unknown-project",
			),
			year,
			month,
			day,
			date: `${year}-${month}-${day}`,
			title: safeFilename(session.title ?? session.sessionId),
			id: safeFilename(session.sessionId).slice(-8) || "session",
		},
	);
	return { rawRelative, content: markdown, currentTitle };
}
