import type { Card as FsrsCard } from 'ts-fsrs';
import { clozes, hideCloze } from './format';
import { fromStored, isNew } from './scheduler';
import { Card, CardState, NEW_PER_DAY, RevlogEntry } from './types';

export interface QueueItem {
	/** key in state.json and the log: the card id, plus `-c2`, `-c3` for the other highlights of a cloze */
	key: string;
	/** which `==highlight==` of a cloze this item asks */
	cloze?: number;
	card: Card;
	fsrs?: FsrsCard;
	suspended: boolean;
}

/** One item per card, one per highlight of a cloze. Cards of removed types are asked as question and answer; `Reverse` is ignored. */
export function buildItems(cards: Card[], state: Record<string, CardState>): QueueItem[] {
	const out: QueueItem[] = [];
	for (const card of cards) {
		if (!card.id) continue;
		const suspended = state[card.id]?.st === 'suspended';
		const holes = card.type === 'Cloze' ? clozes(card.front).length : 0;
		for (let i = 0; i < Math.max(1, holes); i++) {
			const key = i ? `${card.id}-c${i + 1}` : card.id;
			const stored = state[key]?.fsrs;
			out.push({ key, ...(holes ? { cloze: i } : {}), card, ...(stored ? { fsrs: fromStored(stored) } : {}), suspended });
		}
	}
	return out;
}

/** What is asked and what answers it. */
export function faces(item: QueueItem): { front: string; back: string } {
	const { card, cloze } = item;
	if (cloze === undefined) return { front: card.front, back: card.back };
	const hole = clozes(card.front)[cloze] ?? '';
	return { front: hideCloze(card.front, cloze), back: card.back ? `${hole}\n\n${card.back}` : hole };
}

/** Card id of an item key: `lxxxxx` and `lxxxxx-c2` share it. */
export const baseOf = (key: string): string => key.replace(/-.*$/, '');

function endOfDay(now: Date): Date {
	const d = new Date(now);
	d.setHours(23, 59, 59, 999);
	return d;
}

/** Round robin over the first topic, keeping the order inside each group. */
export function interleave(items: QueueItem[]): QueueItem[] {
	const groups = new Map<string, QueueItem[]>();
	for (const it of items) {
		const key = it.card.topics[0] ?? '';
		groups.set(key, [...(groups.get(key) ?? []), it]);
	}
	const lists = [...groups.values()];
	const out: QueueItem[] = [];
	for (let i = 0; out.length < items.length; i++) for (const l of lists) if (l[i]) out.push(l[i] as QueueItem);
	return out;
}

/** Cards that are due today (not new). */
export function dueReviews(items: QueueItem[], now: Date): QueueItem[] {
	const limit = endOfDay(now).getTime();
	return items.filter((it) => !it.suspended && !isNew(it.fsrs) && (it.fsrs as FsrsCard).due.getTime() <= limit);
}

/** Siblings of one card (other highlights) never meet on the same day: the later ones are left out. */
export function burySiblings(items: QueueItem[], gradedToday: Set<string>): QueueItem[] {
	const graded = new Map<string, Set<string>>();
	for (const k of gradedToday) graded.set(baseOf(k), (graded.get(baseOf(k)) ?? new Set()).add(k));
	const seen = new Set<string>();
	return items.filter((it) => {
		const base = baseOf(it.key);
		if (seen.has(base) || [...(graded.get(base) ?? [])].some((k) => k !== it.key)) return false;
		seen.add(base);
		return true;
	});
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** Keys graded today, and how many new cards already entered today. */
export function today(log: RevlogEntry[], now: Date): { graded: Set<string>; introduced: number } {
	const graded = new Set<string>();
	let introduced = 0;
	for (const e of log) {
		if (!sameDay(new Date(e.t), now)) continue;
		graded.add(e.id);
		if (e.new) introduced++;
	}
	return { graded, introduced };
}

/**
 * Everything to review today, in order: due reviews (most at risk first), then new
 * cards up to the daily allowance, mixed by topic. The session takes cards from the
 * front until its time is over; what is left simply stays due.
 */
export function buildQueue(items: QueueItem[], o: { now: Date; log: RevlogEntry[]; retrievability: (c: FsrsCard, now: Date) => number }): QueueItem[] {
	const { graded, introduced } = today(o.log, o.now);
	const pool = items.filter((it) => !it.suspended);
	const r = (it: QueueItem) => o.retrievability(it.fsrs as FsrsCard, o.now);
	const reviews = dueReviews(pool, o.now).sort((a, b) => r(a) - r(b));
	const allowed = Math.max(0, NEW_PER_DAY - introduced);
	// siblings are buried before the cap, so a cloze with three highlights takes one of the slots, not three
	const kept = burySiblings(interleave(reviews).concat(pool.filter((it) => isNew(it.fsrs))), graded);
	return kept.filter((it) => !isNew(it.fsrs)).concat(interleave(kept.filter((it) => isNew(it.fsrs)).slice(0, allowed)));
}

/** When the next card comes back, for the Done screen: `Next card tomorrow`, `Next card in 3 days`; null when nothing is waiting. */
export function nextCardLabel(items: QueueItem[], log: RevlogEntry[], now: Date): string | null {
	const { introduced } = today(log, now);
	const live = items.filter((it) => !it.suspended);
	const dues = live.filter((it) => !isNew(it.fsrs)).map((it) => (it.fsrs as FsrsCard).due.getTime());
	const newLeft = introduced >= NEW_PER_DAY && live.some((it) => isNew(it.fsrs));
	const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = new Set(dues.filter((t) => t > endOfDay(now).getTime()).map((t) => Math.round((startOf(new Date(t)) - startOf(now)) / 86400000)));
	if (newLeft) days.add(1);
	if (!days.size) return null;
	const d = Math.min(...days);
	return d <= 1 ? 'Next card tomorrow' : `Next card in ${d} days`;
}
