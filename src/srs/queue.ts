import { Card as FsrsCard } from 'ts-fsrs';
import { Card, Tipo } from '../cards/types';
import { isNew } from './scheduler';

export interface QueueItem {
	/** key in estado.json and the log: the card id, plus `-r` for the reverse */
	key: string;
	reverso: boolean;
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
	/** keys graded today, to keep a card and its reverse apart */
	gradedToday?: Set<string>;
	/** extra session before an exam: everything in the filter, no new-card cap, no budget cut */
	extra?: boolean;
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
	if (o.extra) {
		const r = (it: QueueItem) => (it.fsrs ? o.retrievability(it.fsrs, o.now) : 0);
		const all = [...pool].sort((a, b) => r(a) - r(b));
		return buryGemeos(o.interleave ? interleave(all) : all, new Set());
	}
	const reviews = dueReviews(pool, o.now).sort(
		(a, b) => o.retrievability(a.fsrs as FsrsCard, o.now) - o.retrievability(b.fsrs as FsrsCard, o.now),
	);
	// a new card and its new reverse count as one introduction
	const fresh: QueueItem[] = [];
	const introduced = new Set<string>();
	for (const it of pool) {
		if (!isNew(it.fsrs)) continue;
		const base = it.card.id ?? it.key;
		if (!introduced.has(base) && introduced.size >= Math.max(0, o.newAllowed)) continue;
		introduced.add(base);
		fresh.push(it);
	}
	const ordered = buryGemeos(o.interleave ? interleave(reviews).concat(interleave(fresh)) : reviews.concat(fresh), o.gradedToday ?? new Set());
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

export function twinOf(key: string): string {
	return key.endsWith('-r') ? key.slice(0, -2) : `${key}-r`;
}

/** A card and its reverse never meet on the same day: the later one is left out. */
export function buryGemeos(items: QueueItem[], gradedToday: Set<string>): QueueItem[] {
	const seen = new Set<string>();
	const out: QueueItem[] = [];
	for (const it of items) {
		const twin = twinOf(it.key);
		if (seen.has(twin) || gradedToday.has(twin)) continue;
		seen.add(it.key);
		out.push(it);
	}
	return out;
}

/**
 * Where a card graded now comes back in the same session: when its next due time
 * falls before the session should end, a few cards ahead (or at the end); -1 otherwise.
 */
export function requeueIndex(queue: QueueItem[], index: number, due: Date, now: Date, secs: Record<Tipo, number>, gap = 3): number {
	const left = queue.slice(index + 1).reduce((s, it) => s + secs[it.card.tipo], 0);
	const end = now.getTime() + Math.max(left, 600) * 1000;
	if (due.getTime() > end) return -1;
	return Math.min(queue.length, index + 1 + gap);
}
