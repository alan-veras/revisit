import { Card as FsrsCard } from 'ts-fsrs';
import { Card, isImportant, Tipo } from '../cards/types';
import { isNew } from './scheduler';

export interface QueueItem {
	/** key in estado.json and the log: the card id, plus `-r` for the reverse */
	key: string;
	reverso: boolean;
	/** which `==highlight==` of a Lacuna this item asks, when the front has them */
	cloze?: number;
	card: Card;
	area: string | null;
	fsrs?: FsrsCard;
	suspended: boolean;
}

/** Area key of the cards whose source has no area: they share one cota. */
export const NO_AREA = 'Sem área';

export interface QueueOptions {
	now: Date;
	area?: string | null;
	/** prefix of an assunto, `Concursos` matches `Concursos > TI` */
	assunto?: string | null;
	budgetMinutes: number;
	newAllowed: number;
	/** new cards still allowed today per area; an area missing here has no cap of its own */
	newLeftByArea?: Map<string, number>;
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
	const byArea = new Map<string, number>();
	const byImportance = [...pool].sort((a, b) => Number(isImportant(b.card)) - Number(isImportant(a.card)));
	for (const it of byImportance) {
		if (!isNew(it.fsrs)) continue;
		const base = it.card.id ?? it.key;
		if (!introduced.has(base)) {
			if (introduced.size >= Math.max(0, o.newAllowed)) continue;
			const key = it.area ?? NO_AREA;
			const left = o.newLeftByArea?.get(key);
			if (left !== undefined && (byArea.get(key) ?? 0) >= left) continue;
			byArea.set(key, (byArea.get(key) ?? 0) + 1);
		}
		introduced.add(base);
		fresh.push(it);
	}
	// at the budget cut, important cards go first inside each block (reviews, then new)
	const important = (l: QueueItem[]) => [...l].sort((a, b) => Number(isImportant(b.card)) - Number(isImportant(a.card)));
	const ordered = buryGemeos(o.interleave ? interleave(reviews).concat(interleave(important(fresh))) : reviews.concat(important(fresh)), o.gradedToday ?? new Set());
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

/** Card id of an item key: `lxxxxx`, `lxxxxx-r` (reverse) and `lxxxxx-c2` (second highlight) share it. */
export function baseOf(key: string): string {
	return key.replace(/-.*$/, '');
}

/** Siblings of one card (reverse, other highlights) never meet on the same day: the later ones are left out. */
export function buryGemeos(items: QueueItem[], gradedToday: Set<string>): QueueItem[] {
	const graded = new Map<string, Set<string>>();
	for (const k of gradedToday) graded.set(baseOf(k), (graded.get(baseOf(k)) ?? new Set()).add(k));
	const seen = new Set<string>();
	const out: QueueItem[] = [];
	for (const it of items) {
		const base = baseOf(it.key);
		if (seen.has(base)) continue;
		if ([...(graded.get(base) ?? [])].some((k) => k !== it.key)) continue;
		seen.add(base);
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

/**
 * Where a graded card comes back in the same session. An extra session brings
 * only an Errei back, always. A normal session brings any grade back whose next
 * due time falls inside the remaining session: the Errei, and the short first
 * steps of a Difícil or Bom on a new card too. -1 stays out.
 */
export function sessionRequeue(o: {
	extra: boolean;
	nota: number;
	queue: QueueItem[];
	index: number;
	due: Date;
	now: Date;
	secs: Record<Tipo, number>;
	gap: number;
}): number {
	if (o.extra) return o.nota === 1 ? Math.min(o.queue.length, o.index + 1 + o.gap) : -1;
	return requeueIndex(o.queue, o.index, o.due, o.now, o.secs, o.gap);
}
