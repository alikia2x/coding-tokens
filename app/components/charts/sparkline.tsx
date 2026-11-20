import { useT } from "~/lib/i18n";

export function Sparkline({
	values,
	className,
}: {
	values: number[];
	className?: string;
}) {
	const t = useT();
	if (values.length === 0) return null;
	const width = 96;
	const height = 22;
	const rawMax = Math.max(0, ...values);
	const max = rawMax > 0 ? rawMax : 1;
	const step = values.length > 1 ? width / (values.length - 1) : width;
	const points = values
		.map(
			(value, index) =>
				`${index * step},${height - (value / max) * (height - 2) - 1}`,
		)
		.join(" ");
	return (
		<svg
			viewBox={`0 0 ${width} ${height}`}
			className={className}
			role="img"
			aria-label={t("metric.costTrend")}
			preserveAspectRatio="none"
		>
			<polyline
				points={points}
				fill="none"
				stroke="var(--chart-1)"
				strokeWidth="1.25"
				vectorEffect="non-scaling-stroke"
			/>
		</svg>
	);
}
