import { State } from 'ts-fsrs';
import { CardType } from '../cards/types';
import { QueueItem } from './queue';

export type CardStatus = 'new' | 'learning' | 'review' | 'suspended';

/** Status shown for one card side: suspension wins, then the FSRS state. */
export function statusOf(it: Pick<QueueItem, 'suspended' | 'fsrs'>): CardStatus {
	if (it.suspended) return 'suspended';
	if (!it.fsrs || it.fsrs.state === State.New) return 'new';
	return it.fsrs.state === State.Review ? 'review' : 'learning';
}

export interface CardRow {
	key: string;
	/** base id of the card (reverse and cloze keys share it) */
	id: string;
	side: string;
	front: string;
	type: CardType;
	source: string | null;
	topics: string[];
	status: CardStatus;
	/** next due, null while the card is new */
	due: Date | null;
	/** due today or overdue */
	dueToday: boolean;
	ok: number;
	bad: number;
	item: QueueItem;
}

/** One row per card side, what the browser and the CLI both show. */
export function cardRow(it: QueueItem, stats: Map<string, { ok: number; bad: number }>, now: Date): CardRow {
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);
	const due = it.fsrs && it.fsrs.state !== State.New ? it.fsrs.due : null;
	const s = it.card.id ? stats.get(it.card.id) : undefined;
	return {
		key: it.key,
		id: it.card.id as string,
		side: it.reverse ? 'reverse' : it.cloze !== undefined ? `cloze ${it.cloze + 1}` : 'front',
		front: it.card.front,
		type: it.card.type,
		source: it.source,
		topics: it.card.topics,
		status: statusOf(it),
		due,
		dueToday: !!due && due.getTime() <= end.getTime(),
		ok: s?.ok ?? 0,
		bad: s?.bad ?? 0,
		item: it,
	};
}

/** Browser order: due or overdue first (oldest on top), then new, then the future. */
export function rowOrder(a: CardRow, b: CardRow): number {
	const rank = (r: CardRow): number => (!r.due ? 1 : r.dueToday ? 0 : 2);
	const d = rank(a) - rank(b);
	if (d !== 0) return d;
	if (a.due && b.due) return a.due.getTime() - b.due.getTime();
	return a.front.localeCompare(b.front);
}
