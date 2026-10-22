import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useSearchParams } from "react-router";
import { formatRangeDates, useDateLocale } from "./date-locale";
import { type TranslationKey, useT } from "./i18n";
import { useSettings } from "./settings";
import {
	isRangeKey,
	type PersistedRange,
	parseRangeValues,
	persistedFromResolved,
	type RangeSelection,
	type ResolvedRange,
	rangeParamsFor,
	readStoredRange,
	resolvePersistedRange,
	resolveRange,
	samePersistedRange,
	writeStoredRange,
} from "./time-range";

interface RangeContextValue {
	range: ResolvedRange;
	setRange: (selection: RangeSelection) => void;
	resetRange: () => void;
}

const RangeContext = createContext<RangeContextValue | null>(null);

export function useNow(intervalMs = 60_000): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
		return () => window.clearInterval(timer);
	}, [intervalMs]);
	return now;
}

export function RangeProvider({ children }: { children: ReactNode }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const { settings } = useSettings();
	const now = useNow();
	const [stored, setStored] = useState<PersistedRange | null>(() =>
		readStoredRange(),
	);
	const storedRef = useRef(stored);
	storedRef.current = stored;

	// Only these three values decide the active range, so typing in a page
	// filter does not churn range-dependent queries.
	const rangeParam = searchParams.get("range");
	const fromParam = searchParams.get("from");
	const toParam = searchParams.get("to");
	const rangeSignature = `${rangeParam ?? ""}\n${fromParam ?? ""}\n${toParam ?? ""}`;

	const range = useMemo(() => {
		const [key, from, to] = rangeSignature.split("\n");
		const fromUrl = parseRangeValues(key, from, to, now);
		if (fromUrl) return fromUrl;
		const fromStorage = resolvePersistedRange(storedRef.current, now);
		if (fromStorage) return fromStorage;
		return resolveRange(new URLSearchParams(), now, settings.defaultRange);
	}, [rangeSignature, now, settings.defaultRange]);

	useEffect(() => {
		const next = persistedFromResolved(range);
		if (samePersistedRange(storedRef.current, next)) return;
		storedRef.current = next;
		setStored(next);
		writeStoredRange(next);
	}, [range, range.key, range.from, range.until]);

	// Keep the URL in sync so links, reloads, and window copies all carry the
	// same range. Unknown or incomplete range params are repaired in place.
	useEffect(() => {
		const current = new URLSearchParams(searchParams.toString());
		const currentKey = current.get("range");
		const needsRepair =
			!isRangeKey(currentKey) ||
			(currentKey === "custom"
				? current.get("from") !== range.fromInput ||
					current.get("to") !== range.toInput
				: current.has("from") || current.has("to"));

		if (!needsRepair) return;

		const next = new URLSearchParams(searchParams.toString());
		next.delete("range");
		next.delete("from");
		next.delete("to");
		for (const [key, value] of Object.entries({
			...rangeParamsFor(range),
		})) {
			next.set(key, value);
		}
		setSearchParams(next, { replace: true });
	}, [searchParams, setSearchParams, range]);

	const setRange = useCallback(
		(selection: RangeSelection) => {
			const nextStored = {
				key: selection.key,
				from: selection.key === "custom" ? (selection.from ?? null) : null,
				until: selection.key === "custom" ? (selection.until ?? null) : null,
			} satisfies PersistedRange;
			storedRef.current = nextStored;
			setStored(nextStored);
			writeStoredRange(nextStored);
			setSearchParams(
				(previous) => {
					const next = new URLSearchParams(previous);
					next.delete("range");
					next.delete("from");
					next.delete("to");
					for (const [key, value] of Object.entries(
						rangeParamsFor(selection),
					)) {
						next.set(key, value);
					}
					return next;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);

	const resetRange = useCallback(() => {
		const fallback =
			isRangeKey(settings.defaultRange) && settings.defaultRange !== "custom"
				? settings.defaultRange
				: "30d";
		setRange({ key: fallback });
	}, [setRange, settings.defaultRange]);

	const value = useMemo(
		() => ({ range, setRange, resetRange }),
		[range, setRange, resetRange],
	);

	return (
		<RangeContext.Provider value={value}>{children}</RangeContext.Provider>
	);
}

export function useRange(): RangeContextValue {
	const context = useContext(RangeContext);
	if (!context) throw new Error("useRange must be used inside RangeProvider");
	return context;
}

export function useResolvedRange(): ResolvedRange {
	return useRange().range;
}

/**
 * The human label for the active range. Custom ranges are formatted at render
 * time so they follow a language switch immediately instead of keeping the
 * locale they were persisted under.
 */
export function useRangeLabel(): string {
	const { range } = useRange();
	const t = useT();
	const { code } = useDateLocale();
	if (range.key === "custom" && range.from !== null && range.until !== null)
		return formatRangeDates(range.from, range.until, code);
	return t(range.label as TranslationKey);
}
