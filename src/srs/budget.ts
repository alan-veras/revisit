import { State } from 'ts-fsrs';
import { CardType } from '../cards/types';

export interface RevlogEntry {
	id: string;
	/** ISO time of the grade */
	t: string;
	grade: number;
	/** seconds from showing the front to grading */
	seconds: number;
	type: CardType;
	/** the card was new before this grade */
	new: boolean;
	extra: boolean;
	/** ts-fsrs State just before the grade (0 new, 1 learning, 2 review, 3 relearning); absent in old lines */
	state?: number;
}

export const DEFAULT_SECS: Record<CardType, number> = { Pergunta: 10, Lacuna: 10, 'Referência': 10, 'Questão': 60 };

/** Median seconds per card type over the last 200 grades of that type. */
export function secsPerType(log: RevlogEntry[]): Record<CardType, number> {
	const out = { ...DEFAULT_SECS };
	for (const type of Object.keys(out) as CardType[]) {
		const xs = log
			.filter((e) => e.type === type && e.seconds > 0)
			.slice(-200)
			.map((e) => Math.min(300, Math.max(3, e.seconds)))
			.sort((a, b) => a - b);
		if (xs.length >= 5) out[type] = xs[Math.floor(xs.length / 2)] as number;
	}
	return out;
}

/** New cards introduced today, by area (ids without a known area are left out). */
export function newTodayByArea(log: RevlogEntry[], now: Date, areaOf: (id: string) => string | null): Map<string, number> {
	const day = now.toDateString();
	const seen = new Set<string>();
	const out = new Map<string, number>();
	for (const e of log) {
		if (!e.new || e.extra || new Date(e.t).toDateString() !== day || seen.has(e.id)) continue;
		seen.add(e.id);
		const area = areaOf(e.id);
		if (area) out.set(area, (out.get(area) ?? 0) + 1);
	}
	return out;
}

export interface QuotaLine {
	area: string;
	used: number;
	cap: number;
	free: number;
}

/** New cards per day of an area with no number of its own. */
export const DEFAULT_AREA_CAP = 5;

export interface QuotaStatus {
	/** the sum of the areas, for display; there is no general cap */
	total: { used: number; cap: number; free: number };
	/** each area: `quota` is the setting, `cap` the quota after the time budget */
	areas: (QuotaLine & { quota: number })[];
	/** due reviews fill the budget, so every quota shrank today */
	reduced: boolean;
}

/**
 * Share of the new-card cap that fits today: all of it while the reviews already
 * due use up to 80% of the budget, none once they pass it, a straight line between.
 */
export function budgetFactor(dueMinutes: number, budgetMinutes: number): number {
	if (budgetMinutes <= 0) return 0;
	const used = dueMinutes / budgetMinutes;
	if (used <= 0.8) return 1;
	if (used >= 1) return 0;
	return (1 - used) / 0.2;
}

/** How many new cards of a cap fit today, after the time budget. */
export function newAllowedToday(dueMinutes: number, budgetMinutes: number, cap: number): number {
	const f = budgetFactor(dueMinutes, budgetMinutes);
	return f === 1 ? cap : Math.floor(cap * f);
}

/** One answer for the session, the panel and the CLI: the new cards left today in each area. */
export function quotaStatus(o: { dueMinutes: number; budgetMinutes: number; areas: readonly string[]; perArea: Record<string, number>; usedByArea: Map<string, number> }): QuotaStatus {
	const f = budgetFactor(o.dueMinutes, o.budgetMinutes);
	const areas = o.areas.map((area) => {
		const quota = o.perArea[area] ?? DEFAULT_AREA_CAP;
		const cap = f === 1 ? quota : Math.floor(quota * f);
		const used = o.usedByArea.get(area) ?? 0;
		return { area, quota, cap, used, free: Math.max(0, cap - used) };
	});
	const sum = (k: 'used' | 'cap' | 'free') => areas.reduce((s, a) => s + a[k], 0);
	return { total: { used: sum('used'), cap: sum('cap'), free: sum('free') }, areas, reduced: f < 1 };
}

/**
 * Minutes of review per day, from today on: what is overdue counts today, then
 * each card on the day it falls due. New and pending cards are left out.
 */
export function forecast(
	items: { card: { type: CardType; pending?: boolean }; fsrs?: { due: Date; state: State }; suspended: boolean }[],
	secs: Record<CardType, number>,
	now: Date,
	days = 7,
): number[] {
	const out = new Array<number>(days).fill(0);
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	for (const it of items) {
		if (it.suspended || it.card.pending || !it.fsrs || it.fsrs.state === State.New) continue;
		const d = Math.max(0, Math.floor((it.fsrs.due.getTime() - start.getTime()) / 86400000));
		if (d < days) out[d] = (out[d] ?? 0) + secs[it.card.type];
	}
	return out.map((s) => Math.round(s / 6) / 10);
}
