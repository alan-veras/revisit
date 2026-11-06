import { heatLevels } from '../srs/stats';

const W = 672;

/** An SVG text-like element: createSvg has no `text` option. */
function svgText(parent: SVGElement, tag: 'text' | 'title', text: string, attr: Record<string, string | number | boolean | null>, cls?: string): void {
	const el = parent.createSvg(tag, { attr, ...(cls ? { cls } : {}) });
	el.textContent = text;
}
const PLOT = { left: 34, right: 664, top: 16, bottom: 148 };

/** A "nice" top for the y axis: 10, 20, 30, 50, 100... above the data and the budget. */
export function niceMax(max: number): number {
	const steps = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 500, 1000];
	return steps.find((s) => s >= max) ?? Math.ceil(max / 100) * 100;
}

/** Path of a bar with rounded top corners. */
function barPath(x: number, w: number, top: number, bottom: number, r = 3): string {
	const rr = Math.min(r, w / 2, bottom - top);
	return `M${x} ${bottom}V${top + rr}Q${x} ${top} ${x + rr} ${top}H${x + w - rr}Q${x + w} ${top} ${x + w} ${top + rr}V${bottom}Z`;
}

/** Minutes per day over the coming days: one hue, a dashed budget line, the peak labelled directly. */
export function drawForecastBars(parent: HTMLElement, perDay: number[], budget: number, dayLabel: (i: number) => string): void {
	const peak = perDay.reduce((m, v, i) => (v > (perDay[m] ?? 0) ? i : m), 0);
	const top = niceMax(Math.max(budget, ...perDay) * 1.05);
	const y = (v: number) => PLOT.bottom - (v / top) * (PLOT.bottom - PLOT.top);
	const svg = parent.createSvg('svg', {
		cls: 'revisit-svg',
		attr: {
			viewBox: `0 0 ${W} 170`,
			width: '100%',
			role: 'img',
			'aria-label': `Minutes of review per day over the next ${perDay.length} days; peak ${Math.round(perDay[peak] ?? 0)} minutes on day ${peak + 1}; daily budget ${budget} minutes`,
		},
	});
	for (const t of [0, top / 3, (2 * top) / 3, top]) {
		svg.createSvg('line', { cls: 'revisit-grid', attr: { x1: PLOT.left, x2: PLOT.right, y1: y(t), y2: y(t) } });
		svgText(svg, 'text', String(Math.round(t)), { x: PLOT.left - 6, y: y(t) + 4, 'text-anchor': 'end' });
	}
	const slot = (PLOT.right - PLOT.left) / perDay.length;
	perDay.forEach((v, i) => {
		const bar = svg.createSvg('path', { cls: 'revisit-bar-fill', attr: { d: barPath(PLOT.left + i * slot + 1, slot - 2, y(Math.max(v, 0.2)), PLOT.bottom) } });
		svgText(bar, 'title', `${dayLabel(i)}: ${Math.round(v)} min`, {});
	});
	svg.createSvg('line', { cls: 'revisit-budget-line', attr: { x1: PLOT.left, x2: PLOT.right, y1: y(budget), y2: y(budget) } });
	svgText(svg, 'text', `budget ${budget} min`, { x: PLOT.right, y: y(budget) - 4, 'text-anchor': 'end' }, 'revisit-label-strong');
	if ((perDay[peak] ?? 0) > 0) {
		const px = PLOT.left + peak * slot + slot / 2;
		svgText(svg, 'text', `peak ${Math.round(perDay[peak] ?? 0)}`, { x: Math.min(Math.max(px, PLOT.left + 20), PLOT.right - 60), y: y(perDay[peak] ?? 0) - 4, 'text-anchor': 'middle' }, 'revisit-label-strong');
	}
	for (const i of [0, 9, 19, perDay.length - 1]) {
		if (i >= perDay.length) continue;
		svgText(svg, 'text', i === 0 ? 'today' : `day ${i + 1}`, { x: PLOT.left + i * slot + slot / 2, y: 165, 'text-anchor': i === 0 ? 'start' : i === perDay.length - 1 ? 'end' : 'middle' });
	}
}

/**
 * Reviews per day for the last days as a calendar grid: a column per week, a row
 * per weekday, five steps (none, then quartiles of the busy days).
 */
export function drawHeatmap(parent: HTMLElement, counts: number[], now: Date, dayText: (date: Date, n: number) => string): void {
	const CELL = 14;
	const GAP = 3;
	const LEFT = 30;
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	start.setDate(start.getDate() - (counts.length - 1));
	const offset = start.getDay();
	const weeks = Math.ceil((offset + counts.length) / 7);
	const levels = heatLevels(counts);
	const total = counts.reduce((a, b) => a + b, 0);
	const svg = parent.createSvg('svg', {
		cls: 'revisit-svg revisit-heatmap',
		attr: {
			viewBox: `0 0 ${LEFT + weeks * (CELL + GAP)} ${7 * (CELL + GAP)}`,
			role: 'img',
			'aria-label': `Reviews per day over the last ${counts.length} days: ${total} reviews in total, ${counts.filter((c) => c > 0).length} days with a session`,
		},
	});
	for (const [row, name] of [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']] as const)
		svgText(svg, 'text', name, { x: LEFT - 6, y: row * (CELL + GAP) + CELL - 2, 'text-anchor': 'end' });
	counts.forEach((n, i) => {
		const slot = offset + i;
		const date = new Date(start);
		date.setDate(start.getDate() + i);
		const cell = svg.createSvg('rect', {
			cls: `revisit-cell is-l${levels[i] ?? 0}`,
			attr: { x: LEFT + Math.floor(slot / 7) * (CELL + GAP), y: (slot % 7) * (CELL + GAP), width: CELL, height: CELL, rx: 3 },
		});
		svgText(cell, 'title', dayText(date, n), {});
	});
}
