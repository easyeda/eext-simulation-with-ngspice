/**
 * 返回数组的 [最小值, 最大值]；空数组返回 [NaN, NaN]。
 * 线性扫描，不展开数组，能安全处理任意大小的数据（Math.min(...xs) 在数万点时
 * 会因超过调用栈参数上限抛 RangeError）。
 */
export function extent(values: ArrayLike<number>): [number, number] {
	let minimum = Number.NaN;
	let maximum = Number.NaN;
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!Number.isFinite(value)) continue;
		if (Number.isNaN(minimum) || value < minimum) minimum = value;
		if (Number.isNaN(maximum) || value > maximum) maximum = value;
	}
	return [minimum, maximum];
}

export function windowedPoints(
	points: Array<[number, number]>,
	minX: number,
	maxX: number,
): Array<[number, number]> {
	if (!points.length) return [];
	const min = Math.min(minX, maxX);
	const max = Math.max(minX, maxX);
	if (!Number.isFinite(min) || !Number.isFinite(max)) return points;

	const start = lowerBoundPoint(points, min);
	const end = upperBoundPoint(points, max);
	const from = Math.max(0, start - 1);
	const to = Math.min(points.length, end + 1);
	return points.slice(from, to);
}

export function downsamplePreserveExtremes(
	points: Array<[number, number]>,
	maxPoints: number,
): Array<[number, number]> {
	if (points.length <= maxPoints || maxPoints < 8) return points;
	const bucketCount = Math.max(1, Math.floor((maxPoints - 2) / 4));
	const bucketSize = points.length / bucketCount;
	const result: Array<[number, number]> = [points[0]];

	for (let bucket = 0; bucket < bucketCount; bucket += 1) {
		const start = Math.max(1, Math.floor(bucket * bucketSize));
		const end = Math.min(points.length - 1, Math.floor((bucket + 1) * bucketSize));
		if (end <= start) continue;

		let minPoint = points[start];
		let maxPoint = points[start];
		for (let index = start + 1; index < end; index += 1) {
			const point = points[index];
			if (point[1] < minPoint[1]) minPoint = point;
			if (point[1] > maxPoint[1]) maxPoint = point;
		}

		const candidates = uniquePoints([points[start], minPoint, maxPoint, points[end - 1]]);
		candidates.sort((a, b) => a[0] - b[0]);
		for (const point of candidates) {
			const last = result[result.length - 1];
			if (!last || last[0] !== point[0] || last[1] !== point[1]) result.push(point);
		}
	}

	const lastPoint = points[points.length - 1];
	const last = result[result.length - 1];
	if (!last || last[0] !== lastPoint[0] || last[1] !== lastPoint[1]) result.push(lastPoint);
	return result.length > maxPoints
		? result.slice(0, maxPoints - 1).concat(lastPoint)
		: result;
}

export function interpolateSeriesValue(
	points: Array<[number, number]>,
	x: number,
): number | null {
	if (!points.length) return null;
	if (x < points[0][0] || x > points[points.length - 1][0]) return null;
	if (x === points[0][0]) return points[0][1];
	let low = 1;
	let high = points.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (points[mid][0] < x) low = mid + 1;
		else high = mid;
	}
	const left = points[low - 1];
	const right = points[low];
	if (!right || right[0] === left[0]) return left[1];
	const ratio = (x - left[0]) / (right[0] - left[0]);
	return left[1] + (right[1] - left[1]) * ratio;
}

/** 最近数据点的实际值（点/线点模式的 snap 语义：数值只落在采样点上）。 */
export function nearestSeriesValue(
	points: Array<[number, number]>,
	x: number,
): number | null {
	if (!points.length) return null;
	if (x <= points[0][0]) return points[0][1];
	const last = points[points.length - 1];
	if (x >= last[0]) return last[1];
	let low = 1;
	let high = points.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (points[mid][0] < x) low = mid + 1;
		else high = mid;
	}
	const left = points[low - 1];
	const right = points[low];
	return (x - left[0]) <= (right[0] - x) ? left[1] : right[1];
}

/** 最近数据点的实际采样点 [x, y]。 */
export function nearestSeriesPoint(
	points: Array<[number, number]>,
	x: number,
): [number, number] | null {
	if (!points.length) return null;
	if (x <= points[0][0]) return points[0];
	const last = points[points.length - 1];
	if (x >= last[0]) return last;
	let low = 1;
	let high = points.length - 1;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (points[mid][0] < x) low = mid + 1;
		else high = mid;
	}
	const left = points[low - 1];
	const right = points[low];
	return (x - left[0]) <= (right[0] - x) ? left : right;
}

function lowerBoundPoint(points: Array<[number, number]>, x: number): number {
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (points[mid][0] < x) low = mid + 1;
		else high = mid;
	}
	return low;
}

function upperBoundPoint(points: Array<[number, number]>, x: number): number {
	let low = 0;
	let high = points.length;
	while (low < high) {
		const mid = Math.floor((low + high) / 2);
		if (points[mid][0] <= x) low = mid + 1;
		else high = mid;
	}
	return low;
}

function uniquePoints(points: Array<[number, number]>): Array<[number, number]> {
	const seen = new Set<string>();
	const result: Array<[number, number]> = [];
	for (const point of points) {
		const key = `${point[0]}\u0000${point[1]}`;
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(point);
	}
	return result;
}
