import { cn } from "cn";
import {
	ChevronDownIcon,
	ChevronLeftIcon,
	ChevronRightIcon,
} from "lucide-react";
import * as React from "react";
import {
	type DayButton,
	DayPicker,
	getDefaultClassNames,
} from "react-day-picker";

import { Button, buttonVariants } from "~/components/ui/button";

const DEFAULT_CALENDAR_CLASS_NAMES = getDefaultClassNames();

function CalendarRoot({
	className,
	rootRef,
	...props
}: React.ComponentProps<"div"> & { rootRef?: React.Ref<HTMLDivElement> }) {
	return (
		<div
			data-slot="calendar"
			ref={rootRef}
			className={cn(className)}
			{...props}
		/>
	);
}

function CalendarChevron({
	className,
	orientation,
	...props
}: {
	className?: string;
	orientation?: "left" | "right" | "up" | "down";
	size?: number;
	disabled?: boolean;
}) {
	if (orientation === "left") {
		return <ChevronLeftIcon className={cn("size-4", className)} {...props} />;
	}

	if (orientation === "right") {
		return <ChevronRightIcon className={cn("size-4", className)} {...props} />;
	}

	return <ChevronDownIcon className={cn("size-4", className)} {...props} />;
}

function CalendarWeekNumber({
	children,
	...props
}: React.ComponentProps<"td">) {
	return (
		<td {...props}>
			<div className="flex size-(--cell-size) items-center justify-center text-center">
				{children}
			</div>
		</td>
	);
}

function Calendar({
	className,
	classNames,
	showOutsideDays = true,
	captionLayout = "label",
	buttonVariant = "ghost",
	formatters,
	components,
	locale,
	...props
}: React.ComponentProps<typeof DayPicker> & {
	buttonVariant?: React.ComponentProps<typeof Button>["variant"];
}) {
	const defaultClassNames = DEFAULT_CALENDAR_CLASS_NAMES;
	const localeCode = locale?.code ?? "en-US";
	const mergedFormatters = React.useMemo(
		() => ({
			formatMonthDropdown: (date: Date) =>
				new Intl.DateTimeFormat(localeCode, { month: "short" }).format(date),
			...formatters,
		}),
		[localeCode, formatters],
	);
	const mergedComponents = React.useMemo(
		() => ({
			Root: CalendarRoot,
			Chevron: CalendarChevron,
			DayButton: CalendarDayButton,
			WeekNumber: CalendarWeekNumber,
			...components,
		}),
		[components],
	);

	return (
		<DayPicker
			showOutsideDays={showOutsideDays}
			className={cn(
				"group/calendar bg-background p-3 [--cell-size:--spacing(8)] [[data-slot=card-content]_&]:bg-transparent [[data-slot=popover-content]_&]:bg-transparent",
				String.raw`rtl:**:[.rdp-button\_next>svg]:rotate-180`,
				String.raw`rtl:**:[.rdp-button\_previous>svg]:rotate-180`,
				className,
			)}
			captionLayout={captionLayout}
			locale={locale}
			formatters={mergedFormatters}
			classNames={{
				root: cn("w-fit", defaultClassNames.root),
				months: cn(
					"relative flex flex-col gap-4 md:flex-row",
					defaultClassNames.months,
				),
				month: cn("flex w-full flex-col gap-4", defaultClassNames.month),
				nav: cn(
					"pointer-events-none absolute inset-x-0 top-0 z-10 flex w-full items-center justify-between gap-1",
					defaultClassNames.nav,
				),
				button_previous: cn(
					buttonVariants({ variant: buttonVariant }),
					"pointer-events-auto size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
					defaultClassNames.button_previous,
				),
				button_next: cn(
					buttonVariants({ variant: buttonVariant }),
					"pointer-events-auto size-(--cell-size) p-0 select-none aria-disabled:opacity-50",
					defaultClassNames.button_next,
				),
				month_caption: cn(
					"relative z-10 flex h-(--cell-size) w-full items-center justify-center px-(--cell-size)",
					defaultClassNames.month_caption,
				),
				dropdowns: cn(
					"flex h-(--cell-size) w-full items-center justify-center gap-1.5 text-sm font-medium",
					defaultClassNames.dropdowns,
				),
				dropdown_root: cn(
					"relative rounded-md border border-input shadow-xs transition-colors hover:bg-muted/60 has-focus:border-ring has-focus:ring-[3px] has-focus:ring-ring/50",
					defaultClassNames.dropdown_root,
				),
				dropdown: cn(
					"absolute inset-0 cursor-pointer bg-popover text-popover-foreground opacity-0",
					defaultClassNames.dropdown,
				),
				caption_label: cn(
					"font-medium select-none",
					captionLayout === "label"
						? "text-sm"
						: "flex h-7 items-center gap-1 rounded-md pr-1.5 pl-2 text-[13px] [&>svg]:size-3.5 [&>svg]:text-muted-foreground",
					defaultClassNames.caption_label,
				),
				month_grid: cn("w-full border-collapse", defaultClassNames.month_grid),
				weekdays: cn("flex", defaultClassNames.weekdays),
				weekday: cn(
					"flex-1 rounded-md text-[0.8rem] font-normal text-muted-foreground select-none",
					defaultClassNames.weekday,
				),
				week: cn("mt-1 flex w-full", defaultClassNames.week),
				week_number_header: cn(
					"w-(--cell-size) select-none",
					defaultClassNames.week_number_header,
				),
				week_number: cn(
					"text-[0.8rem] text-muted-foreground select-none",
					defaultClassNames.week_number,
				),
				day: cn(
					"group/day relative aspect-square h-full w-full p-0 text-center select-none first:rounded-l-md last:rounded-r-md [[data-hidden]+&]:rounded-l-md has-[+[data-hidden]]:rounded-r-md",
					defaultClassNames.day,
				),
				range_start: cn(
					"rounded-l-md bg-primary/12",
					defaultClassNames.range_start,
				),
				range_middle: cn(
					"rounded-none bg-primary/12",
					defaultClassNames.range_middle,
				),
				range_end: cn(
					"rounded-r-md bg-primary/12",
					defaultClassNames.range_end,
				),
				today: cn(
					"rounded-md bg-muted/65 font-semibold text-foreground data-[selected=true]:rounded-none data-[selected=true]:bg-transparent",
					defaultClassNames.today,
				),
				outside: cn(
					"text-muted-foreground aria-selected:text-muted-foreground",
					defaultClassNames.outside,
				),
				disabled: cn(
					"text-muted-foreground opacity-50",
					defaultClassNames.disabled,
				),
				hidden: cn("invisible", defaultClassNames.hidden),
				...classNames,
			}}
			components={mergedComponents}
			{...props}
		/>
	);
}

function CalendarDayButton({
	className,
	day,
	modifiers,
	...props
}: React.ComponentProps<typeof DayButton>) {
	const ref = React.useRef<HTMLButtonElement>(null);
	React.useEffect(() => {
		if (modifiers.focused) ref.current?.focus();
	}, [modifiers.focused]);

	return (
		<Button
			ref={ref}
			variant="ghost"
			size="icon"
			data-day={day.date.toLocaleDateString()}
			data-selected-single={
				modifiers.selected &&
				!modifiers.range_start &&
				!modifiers.range_end &&
				!modifiers.range_middle
			}
			data-range-start={modifiers.range_start}
			data-range-end={modifiers.range_end}
			data-range-middle={modifiers.range_middle}
			className={cn(
				"flex aspect-square size-auto w-full min-w-(--cell-size) flex-col gap-1 leading-none font-normal group-data-[focused=true]/day:relative group-data-[focused=true]/day:z-10 group-data-[focused=true]/day:border-ring group-data-[focused=true]/day:ring-[3px] group-data-[focused=true]/day:ring-ring/50 data-[range-end=true]:rounded-md data-[range-end=true]:bg-primary data-[range-end=true]:text-primary-foreground data-[range-middle=true]:rounded-none data-[range-middle=true]:bg-transparent data-[range-middle=true]:text-accent-foreground data-[range-start=true]:rounded-md data-[range-start=true]:bg-primary data-[range-start=true]:text-primary-foreground data-[selected-single=true]:rounded-md data-[selected-single=true]:bg-primary data-[selected-single=true]:text-primary-foreground dark:hover:text-accent-foreground [&>span]:text-xs [&>span]:opacity-70",
				modifiers.range_start && modifiers.range_end && "rounded-md",
				DEFAULT_CALENDAR_CLASS_NAMES.day,
				className,
			)}
			{...props}
		/>
	);
}

export { Calendar, CalendarDayButton };
