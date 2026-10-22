export function Sparkline({
	values,
	className,
}: {
	values: number[];
	className?: string;
}) {
	const width = 96;
	const height = 22;
	const max = Math.max(1, ...values);
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
			aria-label="Cost trend"
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
