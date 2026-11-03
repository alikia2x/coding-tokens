import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
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
	const accessibleLabel = copied
		? t("common.copied")
		: (label ?? t("common.copy"));

	async function copy(): Promise<void> {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			window.setTimeout(() => setCopied(false), 1200);
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
