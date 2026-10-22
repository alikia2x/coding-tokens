import { SESSION_DETAIL_LEVELS } from "@shared/types";
import { RotateCw } from "lucide-react";
import { Link } from "react-router";
import { PageContainer } from "~/components/page-container";
import { SectionHeading } from "~/components/section-heading";
import { Button } from "~/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { formatDateTime } from "~/lib/format";
import { type TranslationKey, useT } from "~/lib/i18n";
import { useRefreshData, useStatus } from "~/lib/queries";
import { useSettings } from "~/lib/settings";
import { useTheme } from "~/lib/theme";
import { RANGE_PRESETS } from "~/lib/time-range";

export function SettingsPage() {
	const { settings, update, saving } = useSettings();
	const { setMode } = useTheme();
	const status = useStatus();
	const refresh = useRefreshData();
	const t = useT();

	return (
		<PageContainer>
			<div className="flex items-end justify-between gap-3">
				<SectionHeading title={t("nav.settings")} />
				<span className="text-[11px] text-muted-foreground">
					{saving ? t("settings.saving") : t("settings.savedLocally")}
				</span>
			</div>

			<div className="mt-3 divide-y rounded-lg border bg-card">
				<Section title={t("settings.appearance")}>
					<Row label={t("settings.theme")}>
						<ToggleGroup
							type="single"
							variant="outline"
							size="sm"
							value={settings.theme}
							onValueChange={(value) => {
								if (!value) return;
								setMode(value as "light" | "dark" | "system");
								update({ theme: value as "light" | "dark" | "system" });
							}}
						>
							<ToggleGroupItem value="light" className="px-3 text-[11px]">
								{t("theme.light")}
							</ToggleGroupItem>
							<ToggleGroupItem value="dark" className="px-3 text-[11px]">
								{t("theme.dark")}
							</ToggleGroupItem>
							<ToggleGroupItem value="system" className="px-3 text-[11px]">
								{t("theme.system")}
							</ToggleGroupItem>
						</ToggleGroup>
					</Row>
					<Row label={t("settings.language")}>
						<Select
							value={settings.locale}
							onValueChange={(value) =>
								update({ locale: value as "en" | "zh-CN" })
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="en">English</SelectItem>
								<SelectItem value="zh-CN">简体中文</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</Section>

				<Section title={t("settings.defaults")}>
					<Row label={t("range.timeRange")}>
						<Select
							value={settings.defaultRange}
							onValueChange={(value) => update({ defaultRange: value })}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{RANGE_PRESETS.map((preset) => (
									<SelectItem key={preset.key} value={preset.key}>
										{t(preset.label)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row label={t("settings.sessionDetail")}>
						<Select
							value={settings.defaultDetailLevel}
							onValueChange={(value) =>
								update({
									defaultDetailLevel:
										value as typeof settings.defaultDetailLevel,
								})
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								{SESSION_DETAIL_LEVELS.map((level) => (
									<SelectItem key={level.value} value={level.value}>
										{t(level.label as TranslationKey)}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row label={t("settings.includeReviewsSubagents")}>
						<Switch
							checked={settings.includeInternal}
							onCheckedChange={(checked) =>
								update({ includeInternal: checked })
							}
							aria-label="Include internal sessions"
						/>
					</Row>
				</Section>

				<Section title={t("settings.exploreDefaults")}>
					<Row label={t("explore.mode")}>
						<Select
							value={settings.exploreMode}
							onValueChange={(value) =>
								update({ exploreMode: value as typeof settings.exploreMode })
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="time">{t("explore.overTime")}</SelectItem>
								<SelectItem value="dimension">
									{t("explore.byDimension")}
								</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row label={t("explore.metric")}>
						<Select
							value={settings.exploreMetric}
							onValueChange={(value) =>
								update({
									exploreMetric: value as typeof settings.exploreMetric,
								})
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="cost">{t("metric.cost")}</SelectItem>
								<SelectItem value="tokens">{t("metric.tokens")}</SelectItem>
								<SelectItem value="requests">{t("metric.requests")}</SelectItem>
								<SelectItem value="sessions">{t("common.sessions")}</SelectItem>
							</SelectContent>
						</Select>
					</Row>
					<Row label={t("explore.chart")}>
						<Select
							value={settings.exploreChart}
							onValueChange={(value) =>
								update({ exploreChart: value as typeof settings.exploreChart })
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="bar">{t("chart.bar")}</SelectItem>
								<SelectItem value="line">{t("chart.line")}</SelectItem>
								<SelectItem value="area">{t("chart.area")}</SelectItem>
							</SelectContent>
						</Select>
					</Row>
				</Section>

				<Section title={t("settings.data")}>
					<Row label={t("settings.autoRefresh")}>
						<Select
							value={String(settings.autoRefreshMinutes)}
							onValueChange={(value) =>
								update({ autoRefreshMinutes: Number(value) })
							}
						>
							<SelectTrigger size="sm" className="w-[150px] text-[12px]">
								<SelectValue />
							</SelectTrigger>
							<SelectContent align="end">
								<SelectItem value="0">{t("settings.off")}</SelectItem>
								{[5, 15, 30, 60].map((minutes) => (
									<SelectItem key={minutes} value={String(minutes)}>
										{minutes} {t("units.minuteShort")}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Row>
					<Row label={t("status.lastIndexed")}>
						<span className="text-[12px] text-muted-foreground">
							{formatDateTime(status.data?.indexedAt ?? null)}
						</span>
					</Row>
					<Row label={t("status.refresh")}>
						<Button
							variant="outline"
							size="sm"
							disabled={status.data?.indexing || refresh.isPending}
							onClick={() => refresh.mutate()}
						>
							<RotateCw
								className={status.data?.indexing ? "animate-spin" : ""}
							/>
							{t("status.refresh")}
						</Button>
					</Row>
					<Row label={t("harnesses.dataSources")}>
						<Link
							to="/harnesses"
							className="text-[12px] text-muted-foreground underline-offset-2 hover:underline"
						>
							{t("harnesses.viewDataSources")}
						</Link>
					</Row>
				</Section>
			</div>
		</PageContainer>
	);
}

function Section({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<section className="px-4 py-3">
			<h2 className="text-[12px] font-semibold">{title}</h2>
			<div className="mt-2 divide-y">{children}</div>
		</section>
	);
}

function Row({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-4 py-2">
			<span className="text-[12px] text-muted-foreground">{label}</span>
			{children}
		</div>
	);
}
