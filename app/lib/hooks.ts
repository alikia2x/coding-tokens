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
	resetKey?: string | number,
	controlled?: { limit: number; onLimitChange: (next: number) => void },
): {
	limit: number;
	hasMore: boolean;
	sentinelRef: RefObject<HTMLDivElement | null>;
} {
	const [localLimit, setLocalLimit] = useState(initial);
	const prevResetKeyRef = useRef(resetKey);
	const sentinelRef = useRef<HTMLDivElement | null>(null);
	const limit = controlled ? controlled.limit : localLimit;
	const onLimitChange = controlled?.onLimitChange;

	useEffect(() => {
		if (prevResetKeyRef.current === resetKey) return;
		prevResetKeyRef.current = resetKey;
		if (onLimitChange) onLimitChange(initial);
		else setLocalLimit(initial);
	}, [resetKey, initial, onLimitChange]);

	const loadMore = useCallback(() => {
		startTransition(() => {
			const next = Math.min(total, Math.max(initial, limit) + step);
			if (onLimitChange) onLimitChange(next);
			else setLocalLimit(next);
		});
	}, [total, initial, step, limit, onLimitChange]);

	const effectiveLimit = forceAll
		? total
		: Math.min(Math.max(initial, limit), total);
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
