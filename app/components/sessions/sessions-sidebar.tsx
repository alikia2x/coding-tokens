import type { HarnessName, StatusPayload } from "@shared/types";
import { getHarnessLabel, HARNESS_NAMES } from "@shared/types";
import { cn } from "cn";
import { X } from "lucide-react";
import { useMemo } from "react";
import { FacetFilter, type FacetOption } from "~/components/facet-filter";
import { HarnessDot } from "~/components/harness-badge";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatNumber } from "~/lib/format";
import { useT } from "~/lib/i18n";

interface SessionsSidebarProps {
	harness: HarnessName | null;
	projects: string[];
	models: string[];
	includeInternal: boolean;
	showEmpty: boolean;
	hasFilters: boolean;
	totalFiltered: number;
	totalBase: number;
	counts: Map<HarnessName, number>;
	projectOptions: FacetOption[];
	modelOptions: FacetOption[];
	status?: StatusPayload;
	rangeLabel: string;
	onSelectHarness: (harness: HarnessName | null) => void;
	onSetProjects: (values: string[]) => void;
	onSetModels: (values: string[]) => void;
	onToggleInternal: () => void;
	onToggleEmpty: () => void;
	onClearFilters: () => void;
}

export function SessionsSidebar({
	harness,
	projects,
	models,
	includeInternal,
	showEmpty,
	hasFilters,
	totalFiltered,
	totalBase,
	counts,
	projectOptions,
	modelOptions,
	status,
	rangeLabel,
	onSelectHarness,
	onSetProjects,
	onSetModels,
	onToggleInternal,
	onToggleEmpty,
	onClearFilters,
}: SessionsSidebarProps) {
	const t = useT();
	const harnessItems = useMemo(() => {
		if (status?.harnesses?.length) {
			return status.harnesses.map((info) => ({
				name: info.harness,
				info,
			}));
		}
		return HARNESS_NAMES.map((name) => ({
			name,
			info: undefined,
		}));
	}, [status]);

	return (
		<aside className="lg:sticky lg:top-20 lg:self-start">
			<div className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
				{t("common.harnesses")}
			</div>
			<div className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
				<button
					type="button"
					onClick={() => onSelectHarness(null)}
					className={cn(
						"flex h-8 shrink-0 items-center gap-2 rounded px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
						!harness && "bg-muted text-foreground",
					)}
				>
					<span className="flex-1">{t("filters.allHarnesses")}</span>
					<span className="tabular">{totalBase}</span>
				</button>
				{harnessItems.map(({ name, info }) => (
					<button
						key={name}
						type="button"
						onClick={() => onSelectHarness(name)}
						className={cn(
							"flex h-8 shrink-0 items-center gap-2 rounded px-2 text-left text-[12px] text-muted-foreground transition-colors hover:bg-hover hover:text-foreground",
							harness === name && "bg-muted text-foreground",
						)}
						title={info?.available ? undefined : t("harnesses.notInstalled")}
					>
						<HarnessDot harness={name} />
						<span className="flex-1">{getHarnessLabel(name)}</span>
						<span className="tabular">{counts.get(name) ?? 0}</span>
					</button>
				))}
			</div>

			<div className="mt-4 border-t pt-3">
				<div className="mb-2 px-2 text-[11px] font-medium text-muted-foreground">
					{t("common.filters")}
				</div>
				<div className="grid gap-1.5">
					<div className="[&>button]:w-full [&>button]:justify-between">
						<FacetFilter
							label={t("common.project")}
							options={projectOptions}
							values={projects}
							onChange={onSetProjects}
						/>
					</div>
					<div className="[&>button]:w-full [&>button]:justify-between">
						<FacetFilter
							label={t("common.model")}
							options={modelOptions}
							values={models}
							onChange={onSetModels}
						/>
					</div>
					<Button
						variant={includeInternal ? "secondary" : "outline"}
						size="sm"
						className="w-full justify-start"
						onClick={onToggleInternal}
					>
						{includeInternal
							? t("sessions.internalShown")
							: t("sessions.internal")}
					</Button>
					<Button
						variant={showEmpty ? "secondary" : "outline"}
						size="sm"
						className="w-full justify-start"
						aria-pressed={showEmpty}
						onClick={onToggleEmpty}
					>
						{t("sessions.empty")}
					</Button>
					<Button
						variant="ghost"
						size="sm"
						className="w-full justify-start"
						disabled={!hasFilters}
						onClick={onClearFilters}
					>
						<X />
						{t("common.clear")}
					</Button>
				</div>

				<div className="mt-2 flex flex-wrap gap-1.5">
					{projects.map((cwd) => (
						<Badge
							key={cwd}
							variant="outline"
							className="gap-1 rounded font-mono text-[10px]"
						>
							{cwd.split("/").at(-1) ?? cwd}
							<button
								type="button"
								aria-label={t("sessions.clearProjectFilter")}
								onClick={() =>
									onSetProjects(projects.filter((value) => value !== cwd))
								}
							>
								<X className="size-3" />
							</button>
						</Badge>
					))}
					{models.map((model) => (
						<Badge
							key={model}
							variant="outline"
							className="gap-1 rounded text-[10px]"
						>
							{model}
							<button
								type="button"
								aria-label={t("sessions.clearModelFilter")}
								onClick={() =>
									onSetModels(models.filter((value) => value !== model))
								}
							>
								<X className="size-3" />
							</button>
						</Badge>
					))}
				</div>
			</div>

			<div className="mt-4 hidden border-t pt-3 lg:block">
				<div className="text-[11px] text-muted-foreground">
					{formatNumber(totalFiltered)} {t("metric.sessionsLower")}
				</div>
				<div className="mt-1 text-[11px] text-muted-foreground">
					{rangeLabel}
				</div>
			</div>
		</aside>
	);
}
