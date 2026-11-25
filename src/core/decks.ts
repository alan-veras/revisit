import type { Card as FsrsCard } from 'ts-fsrs';
import { faces, QueueItem } from './queue';
import { isNew, State } from './scheduler';

export interface DeckRow {
	key: string;
	/** the question as plain text, a cloze with its blank */
	front: string;
	state: State;
	/** in today's queue */
	today: boolean;
	/** due time of a card already seen; null for a new card */
	due: Date | null;
	/** chance of recalling it now (0 to 1); null for a new card */
	memory: number | null;
}

export interface Deck {
	/** card file path */
	file: string;
	/** file name without `.md` */
	name: string;
	/** folder inside the Revisit folder, '' at its root */
	folder: string;
	rows: DeckRow[];
	counts: { new: number; learning: number; review: number };
	today: number;
}

/** Markdown marks out of a question, for a one-line preview. */
export function plain(md: string): string {
	return md
		.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
		.replace(/\[\[([^\]]+)\]\]/g, '$1')
		.replace(/(\*\*|==|`)/g, '')
		.replace(/^#+\s*|^\s*[-*>]\s+/gm, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** The cards grouped by the file they live in, in name order; `base` is the Revisit folder. */
export function groupDecks(items: QueueItem[], base: string, todayKeys: Set<string>, now: Date, memory: (c: FsrsCard, now: Date) => number): Deck[] {
	const byFile = new Map<string, Deck>();
	for (const it of items) {
		if (it.suspended) continue;
		const file = it.card.file ?? '';
		let deck = byFile.get(file);
		if (!deck) {
			const rel = file.startsWith(base + '/') ? file.slice(base.length + 1) : file;
			const cut = rel.lastIndexOf('/');
			deck = { file, name: rel.slice(cut + 1).replace(/\.md$/, ''), folder: cut < 0 ? '' : rel.slice(0, cut), rows: [], counts: { new: 0, learning: 0, review: 0 }, today: 0 };
			byFile.set(file, deck);
		}
		const fresh = isNew(it.fsrs);
		const state = fresh ? State.New : (it.fsrs as FsrsCard).state;
		const today = todayKeys.has(it.key);
		deck.rows.push({ key: it.key, front: plain(faces(it).front), state, today, due: fresh ? null : (it.fsrs as FsrsCard).due, memory: fresh ? null : memory(it.fsrs as FsrsCard, now) });
		if (fresh) deck.counts.new++;
		else if (state === State.Review) deck.counts.review++;
		else deck.counts.learning++;
		if (today) deck.today++;
	}
	return [...byFile.values()].sort((a, b) => a.name.localeCompare(b.name));
}
