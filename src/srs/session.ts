import { CardType } from '../cards/types';
import { ForecastCard } from './forecast';
import { buildSession, estimateMinutes, QueueItem, QueueOptions } from './queue';

/** The session lengths offered on the start screen, in minutes. */
export const SESSION_MINUTES = [5, 10, 20, 30] as const;

export interface SessionChoice {
	/** minutes asked for; null is "everything due" */
	minutes: number | null;
	/** how many cards fit */
	cards: number;
	/** estimated minutes those cards take */
	estimate: number;
}

/**
 * What each length would hold right now. `base` carries the filters and the
 * new-card allowance; only the time budget changes between the choices. The
 * "everything due" choice has no time cut.
 */
export function sessionChoices(items: QueueItem[], base: Omit<QueueOptions, 'budgetMinutes'>, secs: Record<CardType, number>, minutes: readonly number[] = SESSION_MINUTES): SessionChoice[] {
	const fit = (m: number | null): SessionChoice => {
		const queue = buildSession(items, { ...base, budgetMinutes: m ?? Number.POSITIVE_INFINITY });
		return { minutes: m, cards: queue.length, estimate: estimateMinutes(queue, secs) };
	};
	return [...minutes.map(fit), fit(null)];
}

/**
 * The rows worth showing: a length only appears while it holds more cards than the
 * shorter one before it and fewer than "everything due"; the last row is always there.
 */
export function visibleChoices(choices: SessionChoice[]): SessionChoice[] {
	const everything = choices.find((c) => c.minutes === null);
	if (!everything) return choices;
	const out: SessionChoice[] = [];
	let seen = 0;
	for (const c of choices) {
		if (c.minutes === null || c.cards <= seen || c.cards >= everything.cards) continue;
		out.push(c);
		seen = c.cards;
	}
	return [...out, everything];
}

/** The offered length closest to the daily budget (the lower one on a tie): preselected on the start screen. */
export function nearestChoice(budget: number, minutes: readonly number[] = SESSION_MINUTES): number {
	let best = minutes[0] as number;
	for (const m of minutes) if (Math.abs(m - budget) < Math.abs(best - budget)) best = m;
	return best;
}

export interface SessionSummary {
	cards: number;
	/** share of answers that were not Again, 0 to 100; null with no answers */
	percentRight: number | null;
	/** whole minutes, at least 1 once something was answered */
	minutes: number;
}

/** Totals of a finished session from the count of grades 1 to 4. */
export function summarizeSession(results: Record<1 | 2 | 3 | 4, number>, startedAt: number, now: number): SessionSummary {
	const cards = results[1] + results[2] + results[3] + results[4];
	return {
		cards,
		percentRight: cards ? Math.round(((cards - results[1]) / cards) * 100) : null,
		minutes: cards ? Math.max(1, Math.round((now - startedAt) / 60000)) : 0,
	};
}

/** The fields the forecast reads from a queue item. */
export function toForecastCards(items: readonly QueueItem[]): ForecastCard[] {
	return items.map((it) => ({
		key: it.key,
		type: it.card.type,
		tags: it.card.tags,
		fsrs: it.fsrs,
		suspended: it.suspended,
	}));
}
