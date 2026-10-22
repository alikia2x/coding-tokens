import { cn } from "cn";
import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/button";

export function CopyButton({
	value,
	label = "Copy",
	className,
}: {
	value: string;
	label?: string;
	className?: string;
}) {
	const [copied, setCopied] = useState(false);

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
			aria-label={copied ? "Copied" : label}
			title={copied ? "Copied" : label}
			onClick={() => void copy()}
		>
			{copied ? <Check /> : <Copy />}
		</Button>
	);
}
