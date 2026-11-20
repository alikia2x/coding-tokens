import { parseSearchQuery } from "@shared/search";
import type { HarnessName } from "@shared/types";
import { HARNESS_LABELS } from "@shared/types";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { HarnessDot } from "~/components/harness-badge";
import { Highlight } from "~/components/highlight";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "~/components/ui/command";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { formatCost, formatRelativeTime } from "~/lib/format";
import { useDebouncedValue, useResolvedRange } from "~/lib/hooks";
import { type TranslationKey, useT } from "~/lib/i18n";
import { localizeLabel } from "~/lib/labels";
import { useSearch } from "~/lib/queries";
import {
	sessionsPath as buildSessionsPath,
	rangeQueryString,
	UNKNOWN_PROJECT_KEY,
} from "~/lib/time-range";
import { isMacOS } from "~/lib/use-app-shortcuts";

const pages: Array<{ path: string; label: TranslationKey }> = [
	{ path: "/", label: "nav.overview" },
	{ path: "/sessions", label: "common.sessions" },
	{ path: "/projects", label: "common.projects" },
	{ path: "/models", label: "common.models" },
	{ path: "/harnesses", label: "common.harnesses" },
];

export function CommandSearch() {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [composing, setComposing] = useState(false);
	const settledQuery = composing ? "" : query;
	const debounced = useDebouncedValue(settledQuery, 350);
	const search = useSearch(debounced, open && !composing);
	const navigate = useNavigate();
	const parsed = useMemo(() => parseSearchQuery(debounced), [debounced]);
	const t = useT();
	const range = useResolvedRange();
	const rangeQuery = rangeQueryString(range);

	useEffect(() => {
		const openSearch = () => setOpen(true);
		window.addEventListener("coding-tokens:search", openSearch);
		return () => window.removeEventListener("coding-tokens:search", openSearch);
	}, []);

	function close(): void {
		setOpen(false);
		setQuery("");
		setComposing(false);
	}

	function go(path: string): void {
		navigate(path.includes("?") ? path : `${path}?${rangeQuery}`);
		close();
	}

	const data = search.data;
	const shortcutLabel = isMacOS() ? "Cmd K" : "Ctrl K";
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="inline-flex h-8 items-center gap-2 rounded-md border border-input bg-card px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
				aria-label={t("common.search")}
			>
				<svg viewBox="0 0 16 16" className="size-3.5" aria-hidden="true">
					<circle
						cx="6.8"
						cy="6.8"
						r="4.4"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.3"
					/>
					<path
						d="m10.2 10.2 3.4 3.4"
						stroke="currentColor"
						strokeWidth="1.3"
						strokeLinecap="round"
					/>
				</svg>
				<span className="hidden lg:inline">{t("common.search")}</span>
				<kbd className="hidden rounded border bg-surface px-1 font-mono text-[10px] leading-4 lg:inline">
					{shortcutLabel}
				</kbd>
			</button>
			<Dialog
				open={open}
				onOpenChange={(nextOpen) => {
					if (!nextOpen) close();
					else setOpen(true);
				}}
			>
				<DialogContent
					showCloseButton={false}
					className="top-[18%] max-w-[620px] translate-y-0 gap-0 overflow-hidden p-0"
				>
					<DialogHeader className="sr-only">
						<DialogTitle>{t("common.search")}</DialogTitle>
						<DialogDescription>{t("search.description")}</DialogDescription>
					</DialogHeader>
					<Command shouldFilter={false} loop className="bg-popover">
						<CommandInput
							value={query}
							onValueChange={setQuery}
							onCompositionStart={() => setComposing(true)}
							onCompositionEnd={() => setComposing(false)}
							placeholder={t("search.placeholder")}
							autoFocus
						/>
						<CommandList className="max-h-[440px] p-1">
							{search.isFetching && !data ? (
								<div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
									{t("search.searching")}
								</div>
							) : null}
							<CommandEmpty>
								{search.isFetching ? t("search.searching") : t("empty.results")}
							</CommandEmpty>
							{data?.sessions.length ? (
								<CommandGroup heading={t("common.sessions")}>
									{data.sessions.map((session) => (
										<CommandItem
											key={session.key}
											value={session.key}
											onSelect={() => {
												const find = parsed.terms[0]
													? `?find=${encodeURIComponent(parsed.terms[0])}`
													: "";
												navigate(
													`/sessions/${session.harness}/${encodeURIComponent(session.sessionId)}${find}`,
												);
												close();
											}}
											className="items-start gap-2.5 py-2"
										>
											<HarnessDot
												harness={session.harness}
												className="mt-1.5"
											/>
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px] font-medium">
													<Highlight
														text={localizeLabel(t, session.title)}
														terms={parsed.terms}
													/>
												</div>
												<div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted-foreground">
													<span className="truncate">
														{localizeLabel(t, session.projectName)}
													</span>
													<span className="tabular text-[11px] text-muted-foreground">
														{formatCost(session.costUsd)}
													</span>
													<span>
														{formatRelativeTime(session.lastActivityAt)}
													</span>
												</div>
												{session.snippet ? (
													<div className="mt-1 truncate text-[11px] text-muted-foreground/90">
														<Highlight
															text={session.snippet}
															terms={parsed.terms}
														/>
													</div>
												) : null}
											</div>
											<span className="mt-0.5 text-[10px] text-muted-foreground">
												{HARNESS_LABELS[session.harness]}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
							{data?.projects.length ? (
								<CommandGroup heading={t("common.projects")}>
									{data.projects.map((project) => (
										<CommandItem
											key={project.cwd ?? project.name}
											value={`project-${project.cwd ?? project.name}`}
											onSelect={() =>
												go(
													buildSessionsPath(range, {
														project: project.cwd ?? UNKNOWN_PROJECT_KEY,
													}),
												)
											}
										>
											<div className="min-w-0 flex-1">
												<div className="truncate text-[13px]">
													<Highlight
														text={localizeLabel(t, project.name)}
														terms={parsed.terms}
													/>
												</div>
												<div className="truncate text-[11px] text-muted-foreground">
													{project.cwd}
												</div>
											</div>
											<span className="tabular text-[11px] text-muted-foreground">
												{formatCost(project.costUsd)}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
							{data?.models.length ? (
								<CommandGroup heading={t("common.models")}>
									{data.models.map((model) => (
										<CommandItem
											key={model.model}
											value={`model-${model.model}`}
											onSelect={() =>
												go(buildSessionsPath(range, { model: model.model }))
											}
										>
											<div className="min-w-0 flex-1 truncate text-[13px]">
												<Highlight text={model.model} terms={parsed.terms} />
											</div>
											<span className="tabular text-[11px] text-muted-foreground">
												{formatCost(model.costUsd)}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
							{data?.harnesses.length ? (
								<CommandGroup heading={t("common.harnesses")}>
									{data.harnesses.map((harness) => (
										<CommandItem
											key={harness.harness}
											value={`harness-${harness.harness}`}
											onSelect={() =>
												go(
													buildSessionsPath(range, {
														harness: harness.harness as HarnessName,
													}),
												)
											}
										>
											<HarnessDot harness={harness.harness} />
											<span className="flex-1 text-[13px]">
												{HARNESS_LABELS[harness.harness]}
											</span>
											<span className="tabular text-[11px] text-muted-foreground">
												{formatCost(harness.costUsd)}
											</span>
										</CommandItem>
									))}
								</CommandGroup>
							) : null}
							<CommandSeparator />
							<CommandGroup heading={t("search.pages")}>
								{pages.map((page) => (
									<CommandItem
										key={page.path}
										value={`page-${page.path}`}
										onSelect={() => go(page.path)}
									>
										<span className="text-[13px]">{t(page.label)}</span>
									</CommandItem>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</DialogContent>
			</Dialog>
		</>
	);
}
