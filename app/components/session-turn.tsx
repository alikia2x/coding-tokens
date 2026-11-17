import type {
	DetailItem,
	SessionDetailLevel,
	TurnSummary,
} from "@shared/types";
import { ChevronRight, Wrench } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ToolChain } from "~/components/tool-chain";
import {
	formatCost,
	formatDateTime,
	formatLatency,
	formatThroughput,
	formatTokens,
} from "~/lib/format";
import { type TranslationKey, useT } from "~/lib/i18n";

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

function roleLabelKey(role: DetailItem["role"]): TranslationKey {
	if (role === "system") return "session.system";
	if (role === "developer") return "session.developer";
	return "common.other";
}

function MessageBlock({ item }: { item: DetailItem }) {
	const t = useT();
	if (
		item.role === "system" ||
		item.role === "developer" ||
		item.kind === "other"
	) {
		return (
			<details
				className="group py-2 text-[11px] outline-none"
				data-item-id={item.id}
			>
				<summary className="flex cursor-pointer select-none items-center gap-2 text-muted-foreground outline-none focus-visible:outline-none">
					<Wrench className="size-3.5" />
					{t(roleLabelKey(item.role))}
					<ChevronRight className="ml-auto size-3.5 transition-transform group-open:rotate-90" />
				</summary>
				<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-4 text-muted-foreground">
					{item.text}
				</pre>
			</details>
		);
	}

	const body = item.text ? (
		<div className="chat-markdown">
			<ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
		</div>
	) : null;

	if (item.role === "user") {
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
	}

	return (
		<div className="py-3" data-item-id={item.id}>
			{body}
		</div>
	);
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
	const turnLabel =
		turn.index >= 0
			? t("session.turnNumber", { index: turn.index + 1 })
			: t("session.untracked");
	const turnTokens = totalTokens(turn.totals);

	return (
		<section className="py-3 first:pt-1">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pb-1 text-[10px] text-muted-foreground">
				<span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">
					{turnLabel}
				</span>
				{turn.startedAt ? (
					<span className="tabular">{formatDateTime(turn.startedAt)}</span>
				) : null}
				{turn.requests ? (
					<span>
						{t("count.tokens", {
							count: turnTokens,
							formatted: formatTokens(turnTokens),
						})}
					</span>
				) : null}
				{turn.requests ? (
					<span>
						{formatCost(turn.totals.costUsd, turn.totals.estimatedRequests > 0)}
					</span>
				) : null}
				{turn.durationMs !== null &&
				turn.durationMs !== undefined &&
				turn.durationMs > 0 ? (
					<span className="tabular">{formatLatency(turn.durationMs)}</span>
				) : null}
				{turn.ttftMs !== null && turn.ttftMs !== undefined ? (
					<span className="tabular">
						{t("metric.ttft")} {formatLatency(turn.ttftMs)}
					</span>
				) : null}
				{turn.tokensPerSecond !== null &&
				turn.tokensPerSecond !== undefined &&
				turn.tokensPerSecond > 0 ? (
					<span className="tabular">
						{formatThroughput(turn.tokensPerSecond)}
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
