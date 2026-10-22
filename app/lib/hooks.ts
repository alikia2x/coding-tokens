import { useEffect, useState } from "react";
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
