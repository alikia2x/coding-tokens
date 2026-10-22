import { cn } from "cn";
import { Check, ChevronDown, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "~/components/ui/popover";
import { useT } from "~/lib/i18n";

export interface FacetOption {
	value: string;
	label: string;
	count: number;
}

export function FacetFilter({
	label,
	options,
	values,
	onChange,
}: {
	label: string;
	options: FacetOption[];
	values: string[];
	onChange: (values: string[]) => void;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const filtered = useMemo(() => {
		const term = query.trim().toLowerCase();
		if (!term) return options;
		return options.filter(
			(option) =>
				option.label.toLowerCase().includes(term) ||
				option.value.toLowerCase().includes(term),
		);
	}, [options, query]);

	function toggle(value: string): void {
		onChange(
			values.includes(value)
				? values.filter((item) => item !== value)
				: [...values, value],
		);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setQuery("");
			}}
		>
			<PopoverTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5 font-normal">
					{label}
					{values.length ? (
						<span className="rounded bg-foreground px-1 text-[10px] leading-4 text-background tabular">
							{values.length}
						</span>
					) : null}
					<ChevronDown className="size-3.5 text-muted-foreground" />
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" className="w-64 p-0">
				{options.length > 8 ? (
					<div className="relative border-b p-2">
						<Search className="pointer-events-none absolute left-4 top-4 size-3.5 text-muted-foreground" />
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={`${t("common.filter")} ${label}`}
							className="h-8 pl-7 text-[12px]"
						/>
					</div>
				) : null}
				<div className="max-h-64 overflow-y-auto p-1">
					{filtered.map((option) => {
						const checked = values.includes(option.value);
						return (
							<button
								key={option.value}
								type="button"
								onClick={() => toggle(option.value)}
								className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-hover"
							>
								<span
									className={cn(
										"grid size-3.5 shrink-0 place-items-center rounded-[3px] border",
										checked
											? "border-foreground bg-foreground text-background"
											: "border-input",
									)}
								>
									{checked ? <Check className="size-2.5" /> : null}
								</span>
								<span className="min-w-0 flex-1 truncate text-[12px]">
									{option.label}
								</span>
								<span className="text-[10px] text-muted-foreground tabular">
									{option.count}
								</span>
							</button>
						);
					})}
					{!filtered.length ? (
						<p className="px-2 py-6 text-center text-[12px] text-muted-foreground">
							{t("empty.matches")}
						</p>
					) : null}
				</div>
				<div className="flex items-center justify-between border-t px-2 py-1.5">
					<Button
						variant="ghost"
						size="xs"
						disabled={!values.length}
						onClick={() => onChange([])}
					>
						{t("common.clear")}
					</Button>
					<Button variant="ghost" size="xs" onClick={() => setOpen(false)}>
						{t("common.done")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
