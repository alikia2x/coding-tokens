import {
	type RefObject,
	startTransition,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useSearchParams } from "react-router";

export { useNow, useResolvedRange } from "./range";

export function useDebouncedValue<T>(value: T, delayMs = 150): T {
	const [debounced, setDebounced] = useState(value);
	useEffect(() => {
		const timer = window.setTimeout(() => setDebounced(value), delayMs);
		return () => window.clearTimeout(timer);
	}, [value, delayMs]);
	return debounced;
}

export function useQueryParam(name: string): string | null {
	const [searchParams] = useSearchParams();
	return searchParams.get(name);
}

export function useDocumentTitle(title: string): void {
	useEffect(() => {
		document.title = title ? `${title} | Coding Tokens` : "Coding Tokens";
	}, [title]);
}

export function useMediaQuery(query: string): boolean {
	const [matches, setMatches] = useState(() =>
		typeof window === "undefined" ? true : window.matchMedia(query).matches,
	);
	useEffect(() => {
		const media = window.matchMedia(query);
		const update = () => setMatches(media.matches);
		update();
		media.addEventListener("change", update);
		return () => media.removeEventListener("change", update);
	}, [query]);
	return matches;
}

/**
 * Incrementally expands the rendered slice of large lists/transcripts as the
 * sentinel nears the viewport, keeping WKWebView layout work bounded without
 * relying on content-visibility heuristics.
 */
export function useProgressiveLimit(
	total: number,
	initial: number,
	step = initial,
	forceAll = false,
): {
	limit: number;
	hasMore: boolean;
	sentinelRef: RefObject<HTMLDivElement | null>;
} {
	const [windowState, setWindowState] = useState({ total, limit: initial });
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	const loadMore = useCallback(() => {
		startTransition(() => {
			setWindowState((current) => {
				const base = current.total === total ? current.limit : initial;
				return {
					total,
					limit: Math.min(total, base + step),
				};
			});
		});
	}, [total, initial, step]);

	const activeLimit = windowState.total === total ? windowState.limit : initial;
	const effectiveLimit = forceAll ? total : Math.min(activeLimit, total);
	const hasMore = !forceAll && effectiveLimit < total;

	useEffect(() => {
		if (!hasMore) return;
		const node = sentinelRef.current;
		if (!node || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) {
					loadMore();
				}
			},
			{ rootMargin: "400px 0px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [hasMore, loadMore]);

	return { limit: effectiveLimit, hasMore, sentinelRef };
}
