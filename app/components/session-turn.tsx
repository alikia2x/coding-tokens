import type {
	DetailItem,
	SessionDetailLevel,
	TurnSummary,
} from "@shared/types";
import {
	ChevronRight,
	FolderSearch,
	Pencil,
	Terminal,
	Wrench,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { formatCost, formatDateTime, formatTokens } from "~/lib/format";
import { useT } from "~/lib/i18n";

type Block =
	| { kind: "item"; item: DetailItem }
	| { kind: "tools"; items: DetailItem[] };

function totalTokens(totals: TurnSummary["totals"]): number {
	return (
		totals.inputTokens +
		totals.outputTokens +
		totals.cacheReadTokens +
		totals.cacheWriteTokens
	);
}

function blocksOf(items: DetailItem[]): Block[] {
	const blocks: Block[] = [];
	let tools: DetailItem[] = [];
	const flush = () => {
		if (tools.length) blocks.push({ kind: "tools", items: tools });
		tools = [];
	};
	for (const item of items) {
		if (item.kind === "tool_call" || item.kind === "tool_result") {
			tools.push(item);
		} else {
			flush();
			blocks.push({ kind: "item", item });
		}
	}
	flush();
	return blocks;
}

function embeddedOperations(
	input: string | null,
): Array<{ name: string; detail: string }> {
	if (!input) return [];
	// Codex exec scripts often run a `cmds` array through a single
	// tools.exec_command loop. Show the real commands instead of one "exec".
	if (input.includes("tools.exec_command")) {
		const pairPattern =
			/\[\s*("(?:[^"\\]|\\.)*")\s*,\s*("(?:[^"\\]|\\.)*")\s*\]/gu;
		const commands: string[] = [];
		for (const match of input.matchAll(pairPattern)) {
			try {
				const command: unknown = JSON.parse(match[2] ?? "");
				if (typeof command === "string" && command.trim())
					commands.push(command.trim());
			} catch {}
		}
		if (commands.length > 1)
			return commands.map((detail) => ({ name: "exec_command", detail }));
	}
	if (input.includes("*** Begin Patch")) {
		const files = [
			...input.matchAll(/\*\*\* (?:Add|Update|Delete) File: (.+)/gu),
		]
			.map((match) => match[1]?.trim() ?? "")
			.filter(Boolean);
		if (files.length)
			return files.map((detail) => ({ name: "apply_patch", detail }));
	}
	const operations: Array<{ name: string; detail: string }> = [];
	const pattern = /tools\.([a-zA-Z0-9_]+)\s*\(/gu;
	for (const match of input.matchAll(pattern)) {
		const name = match[1] ?? "tool";
		const start = (match.index ?? 0) + match[0].length;
		const window = input.slice(start, start + 500);
		const detail =
			window.match(
				/(?:cmd|command|path|filename)\s*:\s*["']([^"']+)["']/u,
			)?.[1] ?? "";
		operations.push({ name, detail });
	}
	return operations;
}

function operationCategory(name: string): string {
	if (/exec_command|shell|bash|command/u.test(name)) return "command";
	if (/apply_patch|write|edit/u.test(name)) return "write";
	if (/read|grep|glob|list/u.test(name)) return "read";
	return "other";
}

export function SessionTurn({
	turn,
	items,
	level,
}: {
	turn: TurnSummary;
	items: DetailItem[];
	level: SessionDetailLevel;
}) {
	const t = useT();
	const blocks = blocksOf(items);
	return (
		<section className="py-3 first:pt-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-[10px] text-muted-foreground">
				<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
					{turn.index >= 0
						? `${t("session.turn")} ${turn.index + 1}`
						: t("session.untracked")}
				</span>
				{turn.startedAt ? (
					<span className="tabular">{formatDateTime(turn.startedAt)}</span>
				) : null}
				{turn.requests ? (
					<span>
						{formatTokens(totalTokens(turn.totals))} {t("metric.tokensLower")}
					</span>
				) : null}
				{turn.requests ? (
					<span>
						{formatCost(turn.totals.costUsd, turn.totals.estimatedRequests > 0)}
					</span>
				) : null}
				<span className="ml-auto truncate">
					{turn.models.slice(0, 2).join(", ")}
				</span>
			</div>
			<div>
				{blocks.map((block, index) =>
					block.kind === "tools" ? (
						<ToolChain
							key={`tools-${block.items[0]?.order ?? index}`}
							items={block.items}
							level={level}
						/>
					) : (
						<MessageBlock
							key={`${block.item.order}-${block.item.id}`}
							item={block.item}
						/>
					),
				)}
			</div>
		</section>
	);
}

function MessageBlock({ item }: { item: DetailItem }) {
	const t = useT();
	if (
		item.role === "system" ||
		item.role === "developer" ||
		item.kind === "other"
	)
		return (
			<details
				className="group py-2 text-[11px] outline-none"
				data-item-id={item.id}
			>
				<summary className="flex cursor-pointer select-none items-center gap-2 text-muted-foreground outline-none focus-visible:outline-none">
					<Wrench className="size-3.5" />
					{item.role === "system"
						? t("session.system")
						: item.role === "developer"
							? t("session.developer")
							: t("common.other")}
					<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
				</summary>
				<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-muted-foreground">
					{item.text}
				</pre>
			</details>
		);

	const user = item.role === "user";
	const body = item.text ? (
		<div className="chat-markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
		</div>
	) : null;
	if (user)
		return (
			<div className="flex justify-end py-3" data-item-id={item.id}>
				<div className="max-w-[82%] rounded-lg bg-surface px-4 py-2.5">
					{body}
					<div className="mt-1 text-right text-[10px] text-muted-foreground tabular">
						{item.timestamp ? formatDateTime(item.timestamp) : ""}
					</div>
				</div>
			</div>
		);
	return (
		<div className="py-3" data-item-id={item.id}>
			{body}
		</div>
	);
}

function ToolChain({
	items,
	level,
}: {
	items: DetailItem[];
	level: SessionDetailLevel;
}) {
	const t = useT();
	const calls = items.filter((item) => item.kind === "tool_call");
	const results = items.filter((item) => item.kind === "tool_result");
	const counts = {
		command: calls.filter((item) => item.category === "command").length,
		read: calls.filter((item) => item.category === "read").length,
		write: calls.filter((item) => item.category === "write").length,
		other: calls.filter((item) => !item.category || item.category === "other")
			.length,
	};
	const operationCount = items
		.filter((item) => item.kind === "tool_call")
		.reduce(
			(total, item) =>
				total + Math.max(1, embeddedOperations(item.inputText).length),
			0,
		);
	const summary = [
		counts.command ? `${counts.command} ${t("metric.commands")}` : "",
		counts.read ? `${counts.read} ${t("metric.reads")}` : "",
		counts.write ? `${counts.write} ${t("metric.writes")}` : "",
		counts.other ? `${counts.other} ${t("common.other")}` : "",
	]
		.filter(Boolean)
		.join(", ");
	const pairs: Array<{ call: DetailItem; result?: DetailItem }> = [];
	for (const item of items) {
		if (item.kind === "tool_call") {
			pairs.push({ call: item });
		} else if (item.kind === "tool_result") {
			const target = [...pairs]
				.reverse()
				.find(
					(pair) =>
						!pair.result &&
						(!item.toolCallId || pair.call.toolCallId === item.toolCallId),
				);
			if (target) target.result = item;
			else pairs.push({ call: item });
		}
	}

	return (
		<details className="group py-1 outline-none" open={level === "agent_full"}>
			<summary className="flex cursor-pointer select-none items-center gap-2 rounded-md bg-surface/70 px-2 py-1.5 text-[11px] text-muted-foreground outline-none transition-colors hover:bg-surface focus-visible:outline-none">
				<Terminal className="size-3.5" />
				<span className="font-medium text-foreground">{t("common.tools")}</span>
				<span>{summary || `${calls.length} ${t("session.calls")}`}</span>
				<span className="ml-auto tabular">
					{operationCount} {t("session.operations")}, {results.length}{" "}
					{t("session.results")}
				</span>
				<ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
			</summary>
			<div className="mt-1 space-y-1 rounded-md bg-surface/40 p-2">
				{pairs.map((pair) => (
					<ToolRow
						key={`${pair.call.id}-${pair.call.order}`}
						pair={pair}
						level={level}
					/>
				))}
			</div>
		</details>
	);
}

function ToolRow({
	pair,
	level,
}: {
	pair: { call: DetailItem; result?: DetailItem };
	level: SessionDetailLevel;
}) {
	const { call, result } = pair;
	const operations = embeddedOperations(call.inputText);
	const list =
		operations.length > 0
			? operations.slice(0, 30)
			: [
					{
						name: call.name ?? "tool",
						detail:
							call.inputText?.split("\n")[0]?.slice(0, 160) ??
							call.category ??
							"",
					},
				];
	return (
		<div className="py-1.5">
			<div className="space-y-1">
				{list.map((operation, index) => {
					const category = call.category ?? operationCategory(operation.name);
					const Icon =
						category === "command"
							? Terminal
							: category === "read"
								? FolderSearch
								: category === "write"
									? Pencil
									: Wrench;
					return (
						<div
							key={`${operation.name}-${operation.detail}-${call.order}`}
							className="flex items-start gap-2"
						>
							<Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<div className="flex items-baseline gap-2">
									<span className="truncate text-[11px] font-medium">
										{operation.name}
									</span>
									{call.status && index === 0 ? (
										<span className="text-[10px] text-muted-foreground">
											{call.status}
										</span>
									) : null}
								</div>
								{operation.detail ? (
									<div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
										{operation.detail}
									</div>
								) : null}
							</div>
						</div>
					);
				})}
			</div>
			{level === "agent_full" && call.inputText ? (
				<pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[10px] leading-4">
					{call.inputText}
				</pre>
			) : null}
			{result?.outputText ? (
				<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-background/60 p-2 font-mono text-[10px] leading-4 text-muted-foreground">
					{result.outputText}
				</pre>
			) : null}
		</div>
	);
}
