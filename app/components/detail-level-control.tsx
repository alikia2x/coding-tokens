import { SESSION_DETAIL_LEVELS, type SessionDetailLevel } from "@shared/types";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import { Slider } from "~/components/ui/slider";
import { type TranslationKey, useT } from "~/lib/i18n";

export function DetailLevelControl({
	level,
	onChange,
}: {
	level: SessionDetailLevel;
	onChange: (level: SessionDetailLevel) => void;
}) {
	const t = useT();
	const index = Math.max(
		0,
		SESSION_DETAIL_LEVELS.findIndex((item) => item.value === level),
	);
	const [draft, setDraft] = useState(index);
	const [open, setOpen] = useState(false);
	useEffect(() => setDraft(index), [index]);
	const current = SESSION_DETAIL_LEVELS[draft] ?? SESSION_DETAIL_LEVELS[0];

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-2 font-normal">
					<SlidersHorizontal className="text-muted-foreground" />
					<span>
						{t((current?.label ?? "detail.chat.label") as TranslationKey)}
					</span>
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-4">
				<div className="flex items-baseline justify-between">
					<span className="text-[12px] font-medium">{t("session.detail")}</span>
					<span className="text-[11px] text-muted-foreground">
						{t((current?.label ?? "detail.chat.label") as TranslationKey)}
					</span>
				</div>
				<Slider
					className="mt-4"
					min={0}
					max={SESSION_DETAIL_LEVELS.length - 1}
					step={1}
					value={[draft]}
					onValueChange={([value]) => setDraft(value ?? 0)}
					onValueCommit={([value]) => {
						const next = SESSION_DETAIL_LEVELS[value ?? 0];
						if (next) onChange(next.value);
						setOpen(false);
					}}
				/>
				<div className="mt-2 flex justify-between text-[9px] text-muted-foreground">
					<span>{t("detail.user.label")}</span>
					<span>{t("detail.full.label")}</span>
				</div>
				<p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
					{t(
						(current?.description ??
							"detail.chat.description") as TranslationKey,
					)}
				</p>
			</PopoverContent>
		</Popover>
	);
}
