import { SESSION_DETAIL_LEVELS, type SessionDetailLevel } from "@shared/types";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
	const pointerCommitRef = useRef(false);
	useEffect(() => setDraft(index), [index]);
	const committed = SESSION_DETAIL_LEVELS[index] ?? SESSION_DETAIL_LEVELS[0];
	const preview = SESSION_DETAIL_LEVELS[draft] ?? committed;

	return (
		<Popover
			open={open}
			onOpenChange={(nextOpen) => {
				setOpen(nextOpen);
				setDraft(index);
				pointerCommitRef.current = false;
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-2 font-normal">
					<SlidersHorizontal className="text-muted-foreground" />
					<span>
						{t((committed?.label ?? "detail.chat.label") as TranslationKey)}
					</span>
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-72 p-4">
				<div className="flex items-baseline justify-between">
					<span className="text-[12px] font-medium">{t("session.detail")}</span>
					<span className="text-[11px] text-muted-foreground">
						{t((preview?.label ?? "detail.chat.label") as TranslationKey)}
					</span>
				</div>
				<Slider
					className="mt-4"
					min={0}
					max={SESSION_DETAIL_LEVELS.length - 1}
					step={1}
					value={[draft]}
					onPointerDown={() => {
						pointerCommitRef.current = true;
					}}
					onKeyDown={(event) => {
						pointerCommitRef.current = false;
						if (event.key === "Enter") {
							setOpen(false);
						}
					}}
					onValueChange={([value]) => setDraft(value ?? 0)}
					onValueCommit={([value]) => {
						const next = SESSION_DETAIL_LEVELS[value ?? 0];
						if (next) onChange(next.value);
						if (pointerCommitRef.current) {
							pointerCommitRef.current = false;
							setOpen(false);
						}
					}}
				/>
				<div className="mt-2 flex justify-between text-[9px] text-muted-foreground">
					<span>{t("detail.user.label")}</span>
					<span>{t("detail.full.label")}</span>
				</div>
				<p className="mt-3 border-t pt-2 text-[11px] text-muted-foreground">
					{t(
						(preview?.description ??
							"detail.chat.description") as TranslationKey,
					)}
				</p>
			</PopoverContent>
		</Popover>
	);
}
