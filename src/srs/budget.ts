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

export const DEFAULT_SECS: Record<CardType, number> = { Question: 10, Cloze: 10, Reference: 10, Problem: 60 };

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

/** New cards introduced today (extra sessions do not count). */
export function newToday(log: RevlogEntry[], now: Date): number {
	const day = now.toDateString();
	const seen = new Set<string>();
	for (const e of log) if (e.new && !e.extra && new Date(e.t).toDateString() === day) seen.add(e.id);
	return seen.size;
}

/** New cards per day unless the settings say otherwise. */
export const DEFAULT_NEW_PER_DAY = 20;

export interface QuotaStatus {
	/** the setting */
	quota: number;
	/** the setting after the time budget */
	cap: number;
	used: number;
	free: number;
	/** due reviews fill the budget, so the quota shrank today */
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

/** One answer for the session, the panel and the CLI: the new cards left today. */
export function quotaStatus(o: { dueMinutes: number; budgetMinutes: number; quota: number; used: number }): QuotaStatus {
	const cap = newAllowedToday(o.dueMinutes, o.budgetMinutes, o.quota);
	return { quota: o.quota, cap, used: o.used, free: Math.max(0, cap - o.used), reduced: budgetFactor(o.dueMinutes, o.budgetMinutes) < 1 };
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
