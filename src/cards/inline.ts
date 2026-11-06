import { clozes } from './cloze';
import { FENCE_RE, frontmatterEnd } from './format';
import { Card } from './types';

/**
 * Cards written inside a note: `Question::Answer`, `Question:::Answer` (both
 * ways) and `==cloze==` lines. The note is only read, so they carry no block
 * id: the id comes from the front, and rewording the front makes a new card.
 */

const SR_COMMENT_RE = /\s*<!--SR:[^>]*-->\s*$/;
const BULLET_RE = /^\s*(?:[-*+]|\d+\.)\s+/;

/** FNV-1a over the front: stable across renames and moves of the note. */
export function inlineId(front: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < front.length; i++) {
		h ^= front.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return `i${(h >>> 0).toString(36)}`;
}

/** Same length, with inline code and wikilinks blanked: a `::` there is not a separator. */
function mask(line: string): string {
	return line.replace(/`[^`]*`|\[\[[^\]]*\]\]/g, (m) => ' '.repeat(m.length));
}

function parseLine(line: string): Pick<Card, 'type' | 'front' | 'back' | 'reverse'> | null {
	const masked = mask(line);
	const triple = masked.indexOf(':::');
	const at = triple >= 0 ? triple : masked.indexOf('::');
	if (at >= 0) {
		const front = line.slice(0, at).trim();
		const back = line.slice(at + (triple >= 0 ? 3 : 2)).trim();
		if (!front || !back) return null;
		return { type: 'Question', front, back, ...(triple >= 0 ? { reverse: true } : {}) };
	}
	return clozes(masked).length ? { type: 'Cloze', front: line.trim(), back: '' } : null;
}

/** The inline cards of a note; `source` is the link to the note itself. */
export function parseInlineCards(text: string, source: string): Card[] {
	const lines = text.split('\n');
	const cards = new Map<string, Card>();
	let fence = false;
	for (let i = frontmatterEnd(lines) + 1; i < lines.length; i++) {
		const raw = lines[i] as string;
		if (FENCE_RE.test(raw)) fence = !fence;
		else if (!fence && !/^#{1,6}\s/.test(raw)) {
			const card = parseLine(raw.replace(SR_COMMENT_RE, '').replace(BULLET_RE, ''));
			if (!card) continue;
			const id = inlineId(card.front);
			if (!cards.has(id)) cards.set(id, { ...card, id, topics: [], source, inline: true, start: i, end: i });
		}
	}
	return [...cards.values()];
}
