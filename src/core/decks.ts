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

/** Deck path of a card file: `Revisit/AWS/EC2.md` is `AWS/EC2`. `AWS.md` and the folder `AWS/` are the same deck. */
export function deckOf(file: string, base: string): string {
	return (file.startsWith(base + '/') ? file.slice(base.length + 1) : file).replace(/\.md$/, '');
}

/** The deck itself or anything below it. */
export function inDeck(path: string, deck: string): boolean {
	return path === deck || path.startsWith(deck + '/');
}

/** The deck one level up; '' is the root. */
export function parentDeck(deck: string): string {
	return deck.slice(0, Math.max(0, deck.lastIndexOf('/')));
}

export const deckName = (deck: string): string => deck.slice(deck.lastIndexOf('/') + 1);

/** The immediate subdecks of `parent` ('' is the root) among the deck paths, once each, in name order. */
export function childDecks(paths: string[], parent: string): { path: string; name: string }[] {
	const prefix = parent ? parent + '/' : '';
	const names = new Set<string>();
	for (const p of paths) if (p.startsWith(prefix) && p.length > prefix.length) names.add(p.slice(prefix.length).split('/')[0] as string);
	return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ path: prefix + name, name }));
}

/** `deck` while it still holds something, else its closest ancestor that does; '' is the root. */
export function nearestDeck(paths: string[], deck: string): string {
	let d = deck;
	while (d && !paths.some((p) => inDeck(p, d))) d = parentDeck(d);
	return d;
}

/** The breadcrumb above a deck's title, from the second level on; a long path keeps only the parent after `…`. */
export function crumbs(deck: string): { label: string; path: string }[] {
	const parts = deck.split('/');
	if (parts.length < 2) return [];
	const up = parts.slice(0, -1).map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }));
	if (up.length <= 2) return [{ label: 'Decks', path: '' }, ...up];
	return [{ label: '…', path: (up[up.length - 2] as { path: string }).path }, up[up.length - 1] as { label: string; path: string }];
}

/** A typed subdeck name made safe for a file name; '' when nothing is left. */
export function subdeckName(raw: string): string {
	// a leading dot would hide the file from Obsidian
	return raw.replace(/[:_"<>|?*\\/;]/g, '-').trim().replace(/^\.+/, '').trim();
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
