import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { useT } from "~/lib/i18n";

export function CopyButton({
	value,
	label,
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<number | null>(null);
	const accessibleLabel = copied
		? t("common.copied")
		: (label ?? t("common.copy"));

	useEffect(() => {
		return () => {
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
		};
	}, []);

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			if (timerRef.current !== null) window.clearTimeout(timerRef.current);
			setCopied(true);
			timerRef.current = window.setTimeout(() => {
				setCopied(false);
				timerRef.current = null;
			}, 1200);
		} catch {}
	}

	return (
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			className={cn("text-muted-foreground", className)}
			aria-label={accessibleLabel}
			title={accessibleLabel}
			onClick={() => void copy()}
		>
			{copied ? <Check /> : <Copy />}
		</Button>
	);
}
