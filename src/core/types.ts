import type { Card as FsrsCard } from 'ts-fsrs';

/** One flashcard as written in a card file. Types the UI no longer offers (Reference, Problem) are kept as they are. */
export interface Card {
	id: string | null;
	/** `Question`, `Cloze`, or whatever an older version wrote: preserved on every write */
	type: string;
	front: string;
	back: string;
	topics: string[];
	tags?: string[];
	reverse?: boolean;
	source: string;
	/** card file this card lives in (vault path); set by the store */
	file?: string;
	/** first and last line of the block inside its file (0-based, inclusive) */
	start: number;
	end: number;
}

/** FSRS card as stored in state.json (dates as ISO strings). */
export type StoredFsrs = Omit<FsrsCard, 'due' | 'last_review' | 'state'> & { due: string; last_review?: string; state: number };

/** One entry of state.json, keyed by card id. */
export interface CardState {
	fsrs?: StoredFsrs;
	st?: 'active' | 'suspended';
	[extra: string]: unknown;
}

/** One line of review-log.jsonl. */
export interface RevlogEntry {
	id: string;
	/** ISO time of the grade */
	t: string;
	grade: number;
	seconds: number;
	type: string;
	/** the card was new before this grade */
	new: boolean;
	extra: boolean;
	state?: number;
}

export type Grade = 1 | 2 | 3 | 4;
export const GRADES: { grade: Grade; name: string }[] = [
	{ grade: 1, name: 'Again' },
	{ grade: 2, name: 'Hard' },
	{ grade: 3, name: 'Good' },
	{ grade: 4, name: 'Easy' },
];

/** Cards that enter per day: fixed, never shown. */
export const NEW_PER_DAY = 10;
