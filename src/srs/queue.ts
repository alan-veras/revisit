import { Card as FsrsCard } from 'ts-fsrs';
import { Card, Tipo } from '../cards/types';
import { isNew } from './scheduler';

export interface QueueItem {
	card: Card;
	area: string | null;
	fsrs?: FsrsCard;
	suspended: boolean;
}

export interface QueueOptions {
	now: Date;
	area?: string | null;
	/** prefix of an assunto, `Concursos` matches `Concursos > TI` */
	assunto?: string | null;
	budgetMinutes: number;
	newAllowed: number;
	secs: Record<Tipo, number>;
	interleave: boolean;
	retrievability: (card: FsrsCard, now: Date) => number;
}

export function matchesFilter(item: QueueItem, area?: string | null, assunto?: string | null): boolean {
	if (area && item.area !== area) return false;
	if (assunto) {
		const want = assunto.toLowerCase();
		return item.card.assuntos.some((a) => {
			const x = a.toLowerCase();
			return x === want || x.startsWith(want + ' > ');
		});
	}
	return true;
}

function endOfDay(now: Date): Date {
	const d = new Date(now);
	d.setHours(23, 59, 59, 999);
	return d;
}

/** Round robin over the first assunto, keeping the order inside each group. */
export function interleave(items: QueueItem[]): QueueItem[] {
	const groups = new Map<string, QueueItem[]>();
	for (const it of items) {
		const key = it.card.assuntos[0] ?? '';
		const g = groups.get(key);
		if (g) g.push(it);
		else groups.set(key, [it]);
	}
	const lists = [...groups.values()];
	const out: QueueItem[] = [];
	for (let i = 0; out.length < items.length; i++) for (const l of lists) if (l[i]) out.push(l[i] as QueueItem);
	return out;
}

/** Cards that are due today (not new), whatever the filter says about budget. */
export function dueReviews(items: QueueItem[], now: Date): QueueItem[] {
	const limit = endOfDay(now).getTime();
	return items.filter((it) => !it.suspended && !isNew(it.fsrs) && (it.fsrs as FsrsCard).due.getTime() <= limit);
}

/**
 * The session: due reviews first, most at risk of being forgotten first, then new
 * cards up to the daily allowance; mixed by assunto; cut at the time budget.
 * Due dates are never touched: what does not fit simply shows up again tomorrow.
 */
export function buildSession(items: QueueItem[], o: QueueOptions): QueueItem[] {
	const pool = items.filter((it) => !it.suspended && matchesFilter(it, o.area, o.assunto));
	const reviews = dueReviews(pool, o.now).sort(
		(a, b) => o.retrievability(a.fsrs as FsrsCard, o.now) - o.retrievability(b.fsrs as FsrsCard, o.now),
	);
	const fresh = pool.filter((it) => isNew(it.fsrs)).slice(0, Math.max(0, o.newAllowed));
	const ordered = o.interleave ? interleave(reviews).concat(interleave(fresh)) : reviews.concat(fresh);
	const out: QueueItem[] = [];
	let secs = 0;
	const max = o.budgetMinutes * 60;
	for (const it of ordered) {
		const cost = o.secs[it.card.tipo];
		if (out.length && secs + cost > max) break;
		out.push(it);
		secs += cost;
	}
	return out;
}

export function estimateMinutes(items: QueueItem[], secs: Record<Tipo, number>): number {
	return Math.ceil(items.reduce((s, it) => s + secs[it.card.tipo], 0) / 60);
}
