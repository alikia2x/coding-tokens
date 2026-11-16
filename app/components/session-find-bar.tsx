import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "~/components/ui/button";
import { useT } from "~/lib/i18n";

interface SessionFindBarProps {
	open: boolean;
	draftQuery: string;
	committedQuery: string;
	matchIndex: number;
	matchCount: number;
	inputRef: RefObject<HTMLInputElement | null>;
	onDraftChange: (value: string) => void;
	onSubmit: (reverse?: boolean) => void;
	onStep: (delta: 1 | -1) => void;
	onClear: () => void;
}

function MatchStatus({
	committedQuery,
	draftQuery,
	matchIndex,
	matchCount,
}: {
	committedQuery: string;
	draftQuery: string;
	matchIndex: number;
	matchCount: number;
}) {
	const t = useT();
	const trimmedDraft = draftQuery.trim();
	if (!trimmedDraft) return null;
	if (trimmedDraft !== committedQuery) {
		return (
			<span className="shrink-0 px-1 text-[10px] text-muted-foreground">↵</span>
		);
	}
	if (!matchCount) {
		return (
			<span className="shrink-0 px-1 text-[11px] text-muted-foreground">
				{t("empty.matches")}
			</span>
		);
	}
	return (
		<span className="shrink-0 px-1 text-[11px] text-muted-foreground tabular">
			{matchIndex + 1} / {matchCount}
		</span>
	);
}

export function SessionFindBar({
	open,
	draftQuery,
	committedQuery,
	matchIndex,
	matchCount,
	inputRef,
	onDraftChange,
	onSubmit,
	onStep,
	onClear,
}: SessionFindBarProps) {
	const t = useT();
	if (!open || typeof document === "undefined") return null;

	const canStep = Boolean(draftQuery.trim());

	return createPortal(
		<search
			aria-label={t("session.findInConversation")}
			className="fixed right-4 top-[72px] z-50 flex w-[min(calc(100vw-2rem),380px)] items-center gap-1 rounded-lg border bg-popover/95 px-2.5 py-1.5 shadow-lg backdrop-blur-md sm:right-8 max-md:top-[112px]"
		>
			<Search className="size-3.5 shrink-0 text-muted-foreground" />
			<input
				ref={inputRef}
				value={draftQuery}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={(event) => {
					if (event.nativeEvent.isComposing) return;
					if (event.key === "Enter") {
						event.preventDefault();
						onSubmit(event.shiftKey);
					}
				}}
				placeholder={t("session.findInConversation")}
				className="min-w-0 flex-1 bg-transparent px-1 text-[12px] outline-none placeholder:text-muted-foreground"
				data-conversation-search
			/>
			<MatchStatus
				committedQuery={committedQuery}
				draftQuery={draftQuery}
				matchIndex={matchIndex}
				matchCount={matchCount}
			/>
			<Button
				variant="ghost"
				size="icon-sm"
				disabled={!canStep}
				onClick={() => onStep(-1)}
				aria-label={t("session.previousMatch")}
			>
				<ChevronUp />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				disabled={!canStep}
				onClick={() => onStep(1)}
				aria-label={t("session.nextMatch")}
			>
				<ChevronDown />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				onClick={onClear}
				aria-label={t("common.close")}
			>
				<X />
			</Button>
		</search>,
		document.body,
	);
}
