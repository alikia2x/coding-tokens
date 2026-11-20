import { cn } from "cn";
import type {
	EventListeners,
	OverlayScrollbars,
	PartialOptions,
} from "overlayscrollbars";
import {
	OverlayScrollbarsComponent,
	type OverlayScrollbarsComponentRef,
} from "overlayscrollbars-react";
import {
	type ComponentPropsWithoutRef,
	forwardRef,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";

type ScrollAxisMode = "x" | "y" | "both";

export interface ScrollAreaHandle {
	getViewport: () => HTMLElement | null;
	getElement: () => HTMLElement | null;
	osInstance: () => OverlayScrollbars | null;
}

export interface ScrollAreaProps
	extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
	children?: React.ReactNode;
	contentClassName?: string;
	overflow?: ScrollAxisMode | PartialOptions["overflow"];
	options?: PartialOptions;
	events?: EventListeners;
	defer?: boolean | IdleRequestOptions;
}

function canUseOverlayScrollbars(): boolean {
	if (typeof window === "undefined" || typeof document === "undefined") {
		return false;
	}
	if ("happyDOM" in window) {
		return false;
	}
	if (
		typeof navigator !== "undefined" &&
		/HappyDOM|jsdom/i.test(navigator.userAgent)
	) {
		return false;
	}
	return typeof ResizeObserver !== "undefined";
}

function resolveOverflowOption(
	overflow: ScrollAreaProps["overflow"],
): PartialOptions["overflow"] {
	if (!overflow || overflow === "both") {
		return { x: "scroll", y: "scroll" };
	}
	if (overflow === "y") {
		return { x: "hidden", y: "scroll" };
	}
	if (overflow === "x") {
		return { x: "scroll", y: "hidden" };
	}
	return overflow;
}

function fallbackOverflowClass(overflow: ScrollAreaProps["overflow"]): string {
	if (!overflow || overflow === "both") return "overflow-auto";
	if (overflow === "y") return "overflow-x-hidden overflow-y-auto";
	if (overflow === "x") return "overflow-x-auto overflow-y-hidden";
	const xClass =
		overflow.x === "hidden"
			? "overflow-x-hidden"
			: overflow.x === "visible"
				? "overflow-x-visible"
				: "overflow-x-auto";
	const yClass =
		overflow.y === "hidden"
			? "overflow-y-hidden"
			: overflow.y === "visible"
				? "overflow-y-visible"
				: "overflow-y-auto";
	return `${xClass} ${yClass}`;
}

export const ScrollArea = forwardRef<ScrollAreaHandle, ScrollAreaProps>(
	function ScrollArea(
		{
			className,
			contentClassName,
			children,
			overflow = "both",
			options,
			events,
			defer = true,
			...props
		},
		ref,
	) {
		const osRef = useRef<OverlayScrollbarsComponentRef<"div">>(null);
		const fallbackRef = useRef<HTMLDivElement>(null);
		const useOverlay = canUseOverlayScrollbars();

		useImperativeHandle(
			ref,
			() => ({
				getViewport: () => {
					if (!useOverlay) return fallbackRef.current;
					const instance = osRef.current?.osInstance();
					return (
						instance?.elements().viewport ?? osRef.current?.getElement() ?? null
					);
				},
				getElement: () =>
					useOverlay
						? (osRef.current?.getElement() ?? null)
						: fallbackRef.current,
				osInstance: () =>
					useOverlay ? (osRef.current?.osInstance() ?? null) : null,
			}),
			[useOverlay],
		);

		const mergedOptions = useMemo<PartialOptions>(
			() => ({
				...options,
				overflow: {
					...resolveOverflowOption(overflow),
					...options?.overflow,
				},
				scrollbars: {
					theme: "os-theme-app",
					visibility: "auto",
					autoHide: "scroll",
					autoHideDelay: 700,
					autoHideSuspend: false,
					dragScroll: true,
					clickScroll: true,
					...options?.scrollbars,
				},
			}),
			[overflow, options],
		);

		const body = contentClassName ? (
			<div className={contentClassName}>{children}</div>
		) : (
			children
		);

		if (!useOverlay) {
			return (
				<div
					ref={fallbackRef}
					className={cn(fallbackOverflowClass(overflow), className)}
					{...props}
				>
					{body}
				</div>
			);
		}

		return (
			<OverlayScrollbarsComponent
				ref={osRef}
				element="div"
				defer={defer}
				options={mergedOptions}
				events={events}
				className={className}
				{...props}
			>
				{body}
			</OverlayScrollbarsComponent>
		);
	},
);
