import { cn } from "cn";
import { ArrowDown, ArrowUp } from "lucide-react";
import { TableHead } from "~/components/ui/table";

export interface SortState {
	key: string;
	direction: "asc" | "desc";
}

export function SortableHead({
	label,
	sortKey,
	sort,
	onSort,
	align = "right",
	className,
}: {
	label: string;
	sortKey: string;
	sort: SortState;
	onSort: (key: string) => void;
	align?: "left" | "right";
	className?: string;
}) {
	const active = sort.key === sortKey;
	const ariaSort = active
		? sort.direction === "asc"
			? "ascending"
			: "descending"
		: "none";
	return (
		<TableHead
			aria-sort={ariaSort}
			className={cn(
				"h-9 text-[11px]",
				align === "right" && "text-right",
				className,
			)}
		>
			<button
				type="button"
				onClick={() => onSort(sortKey)}
				className={cn(
					"inline-flex items-center gap-1 transition-colors hover:text-foreground",
					align === "right" && "ml-auto",
					active ? "text-foreground" : "text-muted-foreground",
				)}
			>
				{label}
				{active ? (
					sort.direction === "asc" ? (
						<ArrowUp className="size-3" />
					) : (
						<ArrowDown className="size-3" />
					)
				) : null}
			</button>
		</TableHead>
	);
}
