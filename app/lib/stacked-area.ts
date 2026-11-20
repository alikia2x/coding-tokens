export interface StackedAreaPaths {
	fillPath: string;
	strokePath: string;
}

/**
 * Evaluate a cubic Hermite spline segment at normalized parameter t in [0, 1].
 */
export function evaluateHermiteSegment(
	y0: number,
	y1: number,
	m0: number,
	m1: number,
	dx: number,
	t: number,
): number {
	const t2 = t * t;
	const t3 = t2 * t;
	const h00 = 2 * t3 - 3 * t2 + 1;
	const h10 = t3 - 2 * t2 + t;
	const h01 = -2 * t3 + 3 * t2;
	const h11 = t3 - t2;
	return h00 * y0 + h10 * dx * m0 + h01 * y1 + h11 * dx * m1;
}

function clampEndpointSlope(slope: number, secant: number): number {
	if (secant === 0 || slope * secant <= 0) return 0;
	const maxSlope = 2.5 * Math.abs(secant);
	return Math.abs(slope) > maxSlope ? Math.sign(secant) * maxSlope : slope;
}

/**
 * Compute Fritsch-Carlson monotone cubic spline tangents so an individual
 * non-negative series stays bounded between adjacent knot values and never
 * undershoots zero.
 */
export function computeMonotoneSlopes(
	xs: readonly number[],
	ys: readonly number[],
): number[] {
	const count = xs.length;
	const slopes = new Array<number>(count).fill(0);
	if (count <= 1) return slopes;

	const dx = new Array<number>(count - 1);
	const delta = new Array<number>(count - 1);
	for (let i = 0; i < count - 1; i += 1) {
		const span = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
		dx[i] = span;
		delta[i] = span > 0 ? ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / span : 0;
	}

	if (count === 2) {
		const d0 = delta[0] ?? 0;
		slopes[0] = d0;
		slopes[1] = d0;
		return slopes;
	}

	for (let i = 1; i < count - 1; i += 1) {
		const d0 = delta[i - 1] ?? 0;
		const d1 = delta[i] ?? 0;
		if (d0 * d1 <= 0) {
			slopes[i] = 0;
			continue;
		}
		const h0 = dx[i - 1] ?? 0;
		const h1 = dx[i] ?? 0;
		const w1 = 2 * h1 + h0;
		const w2 = h1 + 2 * h0;
		slopes[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
	}

	const h0 = dx[0] ?? 0;
	const h1 = dx[1] ?? 0;
	const d0 = delta[0] ?? 0;
	const d1 = delta[1] ?? 0;
	const rawStart =
		h0 + h1 > 0 ? ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1) : d0;
	slopes[0] = clampEndpointSlope(rawStart, d0);

	const last = count - 2;
	const hl0 = dx[last] ?? 0;
	const hl1 = dx[last - 1] ?? 0;
	const dl0 = delta[last] ?? 0;
	const dl1 = delta[last - 1] ?? 0;
	const rawEnd =
		hl0 + hl1 > 0 ? ((2 * hl0 + hl1) * dl0 - hl0 * dl1) / (hl0 + hl1) : dl0;
	slopes[count - 1] = clampEndpointSlope(rawEnd, dl0);

	// Enforce the Fritsch-Carlson radius-3 constraint on every interval.
	for (let i = 0; i < count - 1; i += 1) {
		const secant = delta[i] ?? 0;
		if (secant === 0) {
			slopes[i] = 0;
			slopes[i + 1] = 0;
			continue;
		}
		const alpha = (slopes[i] ?? 0) / secant;
		const beta = (slopes[i + 1] ?? 0) / secant;
		const normSq = alpha * alpha + beta * beta;
		if (normSq > 9) {
			const scale = 3 / Math.sqrt(normSq);
			slopes[i] = scale * alpha * secant;
			slopes[i + 1] = scale * beta * secant;
		}
	}

	return slopes;
}

/**
 * Build additive stacked SVG cubic Bezier fill and active-only top stroke paths
 * for each layer up to `seriesHeights.length - 1`.
 *
 * Summing individual non-negative monotone splines yields exact cubic Beziers
 * whose upper boundary can never cross below its lower boundary or below yZero.
 */
export function buildAdditiveStackedAreaPaths(
	xs: readonly number[],
	seriesHeights: readonly (readonly number[])[],
	yZero: number,
	minStrokeHeightPx = 1.2,
): StackedAreaPaths[] {
	const pointCount = xs.length;
	const seriesCount = seriesHeights.length;
	if (pointCount < 2 || seriesCount === 0) {
		return seriesHeights.map(() => ({ fillPath: "", strokePath: "" }));
	}

	const prevH = new Array<number>(pointCount).fill(0);
	const prevM = new Array<number>(pointCount).fill(0);
	const currH = new Array<number>(pointCount).fill(0);
	const currM = new Array<number>(pointCount).fill(0);
	const results: StackedAreaPaths[] = [];

	for (let s = 0; s < seriesCount; s += 1) {
		const heights = seriesHeights[s] ?? [];
		const slopes = computeMonotoneSlopes(xs, heights);

		let hasPositive = false;
		for (let i = 0; i < pointCount; i += 1) {
			const h = Math.max(0, heights[i] ?? 0);
			if (h > 0) hasPositive = true;
			currH[i] = (prevH[i] ?? 0) + h;
			currM[i] = (prevM[i] ?? 0) + (slopes[i] ?? 0);
		}

		if (!hasPositive) {
			results.push({ fillPath: "", strokePath: "" });
			continue;
		}

		const topY = (i: number) => yZero - (currH[i] ?? 0);
		const botY = (i: number) => yZero - (prevH[i] ?? 0);

		const fillCommands: string[] = [
			`M${(xs[0] ?? 0).toFixed(2)},${topY(0).toFixed(2)}`,
		];
		const strokeCommands: string[] = [];
		let strokeOpen = false;

		for (let i = 0; i < pointCount - 1; i += 1) {
			const x0 = xs[i] ?? 0;
			const x1 = xs[i + 1] ?? 0;
			const third = (x1 - x0) / 3;
			const cx1 = x0 + third;
			const cy1 = yZero - ((currH[i] ?? 0) + third * (currM[i] ?? 0));
			const cx2 = x1 - third;
			const cy2 = yZero - ((currH[i + 1] ?? 0) - third * (currM[i + 1] ?? 0));
			const endY = topY(i + 1);
			const seg = `C${cx1.toFixed(2)},${cy1.toFixed(2)},${cx2.toFixed(2)},${cy2.toFixed(2)},${x1.toFixed(2)},${endY.toFixed(2)}`;
			fillCommands.push(seg);

			const h0 = heights[i] ?? 0;
			const h1 = heights[i + 1] ?? 0;
			if (Math.max(h0, h1) >= minStrokeHeightPx) {
				if (!strokeOpen) {
					strokeCommands.push(`M${x0.toFixed(2)},${topY(i).toFixed(2)}`);
					strokeOpen = true;
				}
				strokeCommands.push(seg);
			} else {
				strokeOpen = false;
			}
		}

		fillCommands.push(
			`L${(xs[pointCount - 1] ?? 0).toFixed(2)},${botY(pointCount - 1).toFixed(2)}`,
		);
		for (let i = pointCount - 2; i >= 0; i -= 1) {
			const x0 = xs[i] ?? 0;
			const x1 = xs[i + 1] ?? 0;
			const third = (x1 - x0) / 3;
			const bx2 = x1 - third;
			const by2 = yZero - ((prevH[i + 1] ?? 0) - third * (prevM[i + 1] ?? 0));
			const bx1 = x0 + third;
			const by1 = yZero - ((prevH[i] ?? 0) + third * (prevM[i] ?? 0));
			fillCommands.push(
				`C${bx2.toFixed(2)},${by2.toFixed(2)},${bx1.toFixed(2)},${by1.toFixed(2)},${x0.toFixed(2)},${botY(i).toFixed(2)}`,
			);
		}
		fillCommands.push("Z");

		results.push({
			fillPath: fillCommands.join(""),
			strokePath: strokeCommands.join(""),
		});

		for (let i = 0; i < pointCount; i += 1) {
			prevH[i] = currH[i] ?? 0;
			prevM[i] = currM[i] ?? 0;
		}
	}

	return results;
}
