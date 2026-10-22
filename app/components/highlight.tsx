import { escapeRegExp } from "@shared/search";

export function Highlight({
	text,
	terms,
	className,
}: {
	text: string;
	terms: string[];
	className?: string;
}) {
	const cleaned = terms
		.map((term) => term.trim())
		.filter((term) => term.length > 0)
		.sort((left, right) => right.length - left.length);
	if (!cleaned.length) return <>{text}</>;
	const pattern = new RegExp(`(${cleaned.map(escapeRegExp).join("|")})`, "giu");
	const parts = text.split(pattern);
	return (
		<span className={className}>
			{parts.map((part, index) =>
				pattern.test(part) ? (
					<mark
						// biome-ignore lint/suspicious/noArrayIndexKey: text fragments have no stable key
						key={index}
						className="rounded-[2px] bg-warning-surface px-px text-foreground"
					>
						{part}
					</mark>
				) : (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: text fragments have no stable key
						key={index}
					>
						{part}
					</span>
				),
			)}
		</span>
	);
}
