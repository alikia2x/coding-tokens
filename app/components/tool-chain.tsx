import type {
	DetailItem,
	SessionDetailLevel,
	ToolOperation,
	ToolVerb,
} from "@shared/types";
import {
	Bot,
	ChevronRight,
	FilePenLine,
	FileSearch,
	FileText,
	Folder,
	Globe,
	ListChecks,
	ListTodo,
	MessageCircleQuestion,
	Plug,
	Search,
	Sparkles,
	Terminal,
	Wrench,
} from "lucide-react";
import { formatLatency } from "~/lib/format";
import { type TranslationKey, useT } from "~/lib/i18n";

const VERB_LABEL_KEYS: Partial<Record<ToolVerb, TranslationKey>> = {
	read: "tool.action.read",
	search: "tool.action.search",
	find: "tool.action.find",
	list: "tool.action.list",
	edit: "tool.action.edit",
	write: "tool.action.write",
	command: "tool.action.command",
	webSearch: "tool.action.webSearch",
	fetchUrl: "tool.action.fetchUrl",
	openPage: "tool.action.openPage",
	skill: "tool.action.skill",
	subagent: "tool.action.subagent",
	mcp: "tool.action.mcp",
	todo: "tool.action.todo",
	question: "tool.action.question",
	plan: "tool.action.plan",
};

const FILE_VERBS = new Set<ToolVerb>(["read", "edit", "write", "list"]);

function IconForVerb({ verb }: { verb: ToolVerb }) {
	const cls = "size-3.5 shrink-0 text-muted-foreground/80";
	switch (verb) {
		case "read":
			return <FileText className={cls} />;
		case "search":
			return <Search className={cls} />;
		case "find":
			return <FileSearch className={cls} />;
		case "list":
			return <Folder className={cls} />;
		case "edit":
		case "write":
			return <FilePenLine className={cls} />;
		case "command":
			return <Terminal className={cls} />;
		case "webSearch":
		case "fetchUrl":
		case "openPage":
			return <Globe className={cls} />;
		case "skill":
			return <Sparkles className={cls} />;
		case "subagent":
			return <Bot className={cls} />;
		case "mcp":
			return <Plug className={cls} />;
		case "todo":
			return <ListTodo className={cls} />;
		case "question":
			return <MessageCircleQuestion className={cls} />;
		case "plan":
			return <ListChecks className={cls} />;
		default:
			return <Wrench className={cls} />;
	}
}

interface ToolPair {
	call: DetailItem;
	result?: DetailItem;
	operations: ToolOperation[];
}

function fallbackOperation(call: DetailItem): ToolOperation {
	const rawName = call.name ?? "tool";
	let verb: ToolVerb = "other";
	if (call.category === "command") verb = "command";
	else if (call.category === "read") verb = "read";
	else if (call.category === "write") verb = "edit";
	return { verb, rawName, target: "" };
}

function pairChainItems(items: DetailItem[]): ToolPair[] {
	const pairs: ToolPair[] = [];
	for (const item of items) {
		if (item.kind === "tool_call") {
			pairs.push({
				call: item,
				operations: item.operations?.length
					? item.operations
					: [fallbackOperation(item)],
			});
			continue;
		}
		if (item.kind !== "tool_result") continue;
		const target = [...pairs]
			.reverse()
			.find(
				(pair) =>
					!pair.result &&
					(!item.toolCallId || pair.call.toolCallId === item.toolCallId),
			);
		if (target) {
			target.result = item;
		} else {
			pairs.push({
				call: item,
				result: item,
				operations: item.operations?.length
					? item.operations
					: [fallbackOperation(item)],
			});
		}
	}
	return pairs;
}

function summarizeOperations(
	ops: ToolOperation[],
	pairCount: number,
	t: (key: TranslationKey) => string,
): string {
	const hasRead = ops.some((op) => op.verb === "read" || op.verb === "list");
	const hasSearch = ops.some(
		(op) =>
			op.verb === "search" ||
			op.verb === "find" ||
			op.verb === "webSearch" ||
			op.verb === "openPage" ||
			op.verb === "fetchUrl",
	);
	const hasEdit = ops.some((op) => op.verb === "edit" || op.verb === "write");
	const hasCommand = ops.some((op) => op.verb === "command");

	const parts: string[] = [];
	if (hasRead) parts.push(t("tool.summary.read"));
	if (hasSearch) parts.push(t("tool.summary.searched"));
	if (hasEdit) parts.push(t("tool.summary.edited"));
	if (hasCommand) parts.push(t("tool.summary.commands"));
	if (!parts.length && ops.length > 0) parts.push(t("tool.summary.other"));

	const rawSummary = parts.join(", ");
	if (!rawSummary) return `${pairCount} ${t("session.calls")}`;
	return rawSummary.charAt(0).toUpperCase() + rawSummary.slice(1);
}

function ToolRowLine({
	op,
	durationMs,
}: {
	op: ToolOperation;
	durationMs?: number | null;
}) {
	const t = useT();
	const labelKey = VERB_LABEL_KEYS[op.verb];
	const actionLabel = labelKey ? t(labelKey) : op.rawName;
	const isFile = FILE_VERBS.has(op.verb);
	const hasDuration = Boolean(durationMs && durationMs > 0);

	return (
		<div className="flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 text-[12px]">
			<IconForVerb verb={op.verb} />
			<span className="shrink-0 text-muted-foreground">{actionLabel}</span>
			{op.target ? (
				<>
					<span className="shrink-0 text-muted-foreground/50">·</span>
					<span
						className={
							isFile
								? "min-w-0 truncate text-foreground/90 underline decoration-border/70 underline-offset-2"
								: "min-w-0 truncate font-mono text-[11px] text-foreground/85"
						}
						title={op.fullTarget ?? op.target}
					>
						{op.target}
					</span>
				</>
			) : null}
			{op.meta ? (
				<span className="shrink-0 font-mono text-[11px] text-muted-foreground/75">
					{op.meta}
				</span>
			) : null}
			{hasDuration || op.errorBadge ? (
				<span className="ml-auto flex shrink-0 items-center gap-1.5">
					{hasDuration ? (
						<span className="font-mono text-[10px] text-muted-foreground/75 tabular">
							{formatLatency(durationMs)}
						</span>
					) : null}
					{op.errorBadge ? (
						<span className="rounded bg-destructive/15 px-1.5 py-0.2 font-mono text-[10px] text-destructive">
							{op.errorBadge}
						</span>
					) : null}
				</span>
			) : null}
		</div>
	);
}

function ToolPayloadDrawer({
	inputText,
	outputText,
}: {
	inputText: string | null;
	outputText: string | null;
}) {
	const t = useT();
	return (
		<div className="space-y-1.5">
			{inputText ? (
				<div>
					<div className="mb-0.5 text-[10px] font-medium text-muted-foreground/80">
						{t("tool.input")}
					</div>
					<pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/70 p-2 font-mono text-[10px] leading-4 text-foreground/85">
						{inputText}
					</pre>
				</div>
			) : null}
			{outputText ? (
				<div>
					<div className="mb-0.5 text-[10px] font-medium text-muted-foreground/80">
						{t("tool.output")}
					</div>
					<pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-border/40 bg-background/70 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
						{outputText}
					</pre>
				</div>
			) : null}
		</div>
	);
}

function ToolRow({ pair }: { pair: ToolPair }) {
	const { call, result, operations } = pair;
	const inputText = call.kind === "tool_call" ? call.inputText : null;
	const outputText = result?.outputText ?? null;
	const hasDetails = Boolean(inputText || outputText);
	const counts = new Map<string, number>();

	const operationLines = operations.map((op, index) => {
		const base = `${op.rawName}-${op.target}-${call.order}`;
		const seen = (counts.get(base) ?? 0) + 1;
		counts.set(base, seen);
		return (
			<ToolRowLine
				key={`${base}-${seen}`}
				op={op}
				durationMs={index === 0 ? call.durationMs : undefined}
			/>
		);
	});

	if (!hasDetails) {
		return <div className="-mx-1 px-1 py-0.5">{operationLines}</div>;
	}

	return (
		<details className="group/row py-0.5 outline-none">
			<summary className="-mx-1 flex cursor-pointer list-none items-start gap-1.5 rounded px-1 transition-colors hover:bg-surface/50 [&::-webkit-details-marker]:hidden">
				<div className="min-w-0 flex-1">{operationLines}</div>
				<ChevronRight className="mt-1 size-3 shrink-0 text-muted-foreground/0 transition-all group-hover/row:text-muted-foreground/60 group-open/row:rotate-90 group-open/row:text-muted-foreground/80" />
			</summary>
			<div className="mt-1 mb-1.5 ml-5">
				<ToolPayloadDrawer inputText={inputText} outputText={outputText} />
			</div>
		</details>
	);
}

export function ToolChain({
	items,
	level,
}: {
	items: DetailItem[];
	level: SessionDetailLevel;
}) {
	const t = useT();
	const pairs = pairChainItems(items);
	const allOps = pairs.flatMap((pair) => pair.operations);
	const summaryLabel = summarizeOperations(allOps, pairs.length, t);
	const hasErrors = allOps.some((op) => Boolean(op.errorBadge));
	const totalDurationMs = pairs.reduce(
		(sum, pair) => sum + (pair.call.durationMs ?? 0),
		0,
	);

	return (
		<details
			className="group py-1.5 outline-none"
			open={level === "agent_full"}
		>
			<summary className="flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground outline-none transition-colors hover:bg-surface/60 hover:text-foreground focus-visible:outline-none">
				<ChevronRight className="size-3.5 shrink-0 text-muted-foreground/70 transition-transform group-open:rotate-90" />
				<span className="truncate font-medium">{summaryLabel}</span>
				<span className="ml-auto shrink-0 text-[10px] tabular text-muted-foreground/75">
					{allOps.length}
					{totalDurationMs > 0 ? ` · ${formatLatency(totalDurationMs)}` : ""}
					{hasErrors ? " · !" : ""}
				</span>
			</summary>
			<div className="mt-1 ml-3 border-l border-border/50 pl-3">
				{pairs.map((pair) => (
					<ToolRow key={`${pair.call.id}-${pair.call.order}`} pair={pair} />
				))}
			</div>
		</details>
	);
}
