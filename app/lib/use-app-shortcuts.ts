import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { useResolvedRange } from "~/lib/hooks";
import { useRefreshData } from "~/lib/queries";
import { rangeQueryString } from "~/lib/time-range";
import type { TranslationKey } from "./i18n";

export function isMacOS(): boolean {
	if (typeof navigator === "undefined") return true;
	return /Mac|iPhone|iPad|iPod/iu.test(
		navigator.platform || navigator.userAgent,
	);
}

const routes = [
	"/",
	"/explore",
	"/sessions",
	"/projects",
	"/models",
	"/harnesses",
];

function isTyping(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return Boolean(
		target.closest("input, textarea, select, [contenteditable='true']"),
	);
}

function focusSearch(): boolean {
	const input = document.querySelector<HTMLInputElement>("[data-search-input]");
	if (!input) return false;
	input.focus();
	input.select();
	return true;
}

export function useAppShortcuts(): {
	helpOpen: boolean;
	setHelpOpen: (open: boolean) => void;
} {
	const navigate = useNavigate();
	const refresh = useRefreshData();
	const mutateRefresh = refresh.mutate;
	const range = useResolvedRange();
	const rangeQueryRef = useRef(rangeQueryString(range));
	rangeQueryRef.current = rangeQueryString(range);
	const [helpOpen, setHelpOpen] = useState(false);

	useEffect(() => {
		function onKeyDown(event: KeyboardEvent): void {
			const meta = event.metaKey || event.ctrlKey;
			const key = event.key.toLowerCase();
			if (meta && key === "k") {
				event.preventDefault();
				window.dispatchEvent(new Event("coding-tokens:search"));
				return;
			}
			if (meta && key === "r") {
				event.preventDefault();
				mutateRefresh();
				return;
			}
			if (meta && key === "f") {
				event.preventDefault();
				if (!focusSearch()) {
					const onDetail = /^\/sessions\/[^/]+\/[^/]+/u.test(
						window.location.pathname,
					);
					window.dispatchEvent(
						new Event(onDetail ? "coding-tokens:find" : "coding-tokens:search"),
					);
				}
				return;
			}
			if (meta && /^[1-6]$/u.test(event.key)) {
				const index = Number(event.key) - 1;
				const route = routes[index];
				if (route) {
					event.preventDefault();
					const query = rangeQueryRef.current;
					navigate(query ? `${route}?${query}` : route);
				}
				return;
			}
			if (!meta && !event.altKey && !isTyping(event.target) && key === "/") {
				event.preventDefault();
				if (!focusSearch())
					window.dispatchEvent(new Event("coding-tokens:search"));
				return;
			}
			if (
				!meta &&
				!event.altKey &&
				!isTyping(event.target) &&
				event.key === "?"
			) {
				event.preventDefault();
				setHelpOpen(true);
			}
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [navigate, mutateRefresh]);

	return { helpOpen, setHelpOpen };
}

export const shortcuts: Array<{ keys: string; label: TranslationKey }> = [
	{ keys: "⌘ K", label: "common.search" },
	{ keys: "⌘ F", label: "shortcuts.findInPage" },
	{ keys: "⌘ R", label: "status.refresh" },
	{ keys: "⌘ 1", label: "nav.overview" },
	{ keys: "⌘ 2", label: "nav.explore" },
	{ keys: "⌘ 3", label: "common.sessions" },
	{ keys: "⌘ 4", label: "common.projects" },
	{ keys: "⌘ 5", label: "common.models" },
	{ keys: "⌘ 6", label: "common.harnesses" },
	{ keys: "/", label: "shortcuts.focusSearch" },
	{ keys: "?", label: "shortcuts.title" },
];
