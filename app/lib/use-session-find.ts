import {
	type RefObject,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { SetURLSearchParams } from "react-router";

interface CssHighlightRegistry {
	set: (name: string, highlight: unknown) => void;
	delete: (name: string) => void;
}

function getCssHighlights(): CssHighlightRegistry | null {
	const highlights = (CSS as unknown as { highlights?: CssHighlightRegistry })
		.highlights;
	return highlights ?? null;
}

function collectMatchRanges(root: HTMLElement, needle: string): Range[] {
	const ranges: Range[] = [];
	const lowerNeedle = needle.toLowerCase();
	for (const message of root.querySelectorAll("[data-item-id]")) {
		const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
		let node = walker.nextNode();
		while (node) {
			const text = node.nodeValue ?? "";
			const lowerText = text.toLowerCase();
			let index = lowerText.indexOf(lowerNeedle);
			while (index >= 0) {
				const range = document.createRange();
				range.setStart(node, index);
				range.setEnd(node, index + lowerNeedle.length);
				ranges.push(range);
				index = lowerText.indexOf(lowerNeedle, index + lowerNeedle.length);
			}
			node = walker.nextNode();
		}
	}
	return ranges;
}

export function useSessionFind({
	containerRef,
	contentVersion,
	searchParams,
	setSearchParams,
}: {
	containerRef: RefObject<HTMLDivElement | null>;
	contentVersion: string;
	searchParams: URLSearchParams;
	setSearchParams: SetURLSearchParams;
}) {
	const initialFind = searchParams.get("find")?.trim() ?? "";
	const [open, setOpen] = useState(() => searchParams.has("find"));
	const [draftQuery, setDraftQuery] = useState(initialFind);
	const [committedQuery, setCommittedQuery] = useState(initialFind);
	const [matchIndex, setMatchIndex] = useState(0);
	const [matchCount, setMatchCount] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const shouldScrollRef = useRef(Boolean(initialFind));

	const close = useCallback(() => {
		setOpen(false);
		if (!searchParams.has("find")) return;
		const next = new URLSearchParams(searchParams);
		next.delete("find");
		setSearchParams(next, { replace: true });
	}, [searchParams, setSearchParams]);

	const toggle = useCallback(() => {
		if (open) {
			close();
			return;
		}
		setOpen(true);
	}, [open, close]);

	const clear = useCallback(() => {
		setDraftQuery("");
		setCommittedQuery("");
		setMatchIndex(0);
		setMatchCount(0);
		close();
	}, [close]);

	const submit = useCallback(
		(reverse = false) => {
			const nextQuery = draftQuery.trim();
			if (!nextQuery) {
				setCommittedQuery("");
				setMatchIndex(0);
				setMatchCount(0);
				return;
			}
			shouldScrollRef.current = true;
			if (nextQuery !== committedQuery) {
				setCommittedQuery(nextQuery);
				setMatchIndex(0);
				return;
			}
			if (!matchCount) return;
			setMatchIndex((current) => {
				if (reverse) return (current - 1 + matchCount) % matchCount;
				return (current + 1) % matchCount;
			});
		},
		[draftQuery, committedQuery, matchCount],
	);

	const step = useCallback(
		(delta: 1 | -1) => {
			if (draftQuery.trim() !== committedQuery) {
				submit(delta < 0);
				return;
			}
			if (!matchCount) return;
			shouldScrollRef.current = true;
			setMatchIndex((current) => (current + delta + matchCount) % matchCount);
		},
		[draftQuery, committedQuery, matchCount, submit],
	);

	useEffect(() => {
		const root = containerRef.current;
		const highlights = getCssHighlights();
		const HighlightCtor = (
			window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }
		).Highlight;

		highlights?.delete("transcript-search");
		highlights?.delete("transcript-search-current");

		if (!open || !root || !committedQuery || !contentVersion) {
			setMatchCount(0);
			return;
		}

		const ranges = collectMatchRanges(root, committedQuery);
		setMatchCount(ranges.length);

		if (!highlights || !HighlightCtor || !ranges.length) return;

		highlights.set("transcript-search", new HighlightCtor(...ranges));
		const current = ranges[Math.min(matchIndex, ranges.length - 1)];
		if (current) {
			highlights.set("transcript-search-current", new HighlightCtor(current));
			if (shouldScrollRef.current) {
				shouldScrollRef.current = false;
				current.startContainer.parentElement?.scrollIntoView({
					block: "center",
					behavior: "smooth",
				});
			}
		}

		return () => {
			highlights.delete("transcript-search");
			highlights.delete("transcript-search-current");
		};
	}, [open, committedQuery, contentVersion, matchIndex, containerRef]);

	useEffect(() => {
		const onFindShortcut = () => {
			setOpen(true);
			window.requestAnimationFrame(() => {
				inputRef.current?.focus();
				inputRef.current?.select();
			});
		};
		window.addEventListener("coding-tokens:find", onFindShortcut);
		return () =>
			window.removeEventListener("coding-tokens:find", onFindShortcut);
	}, []);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			close();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open, close]);

	return {
		open,
		draftQuery,
		committedQuery,
		matchIndex,
		matchCount,
		inputRef,
		setDraftQuery,
		toggle,
		submit,
		step,
		clear,
	};
}
