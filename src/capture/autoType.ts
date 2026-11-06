import { clozes } from '../cards/cloze';
import { CardType } from '../cards/types';

export const CLOZE_MAX_WORDS = 8;

export function wordCount(text: string): number {
	return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** The type the capture window opens with. */
export function initialType(o: { isPdf: boolean; hasReference: boolean; selection: string }): CardType {
	if (o.isPdf && o.selection) return 'Problem';
	if (o.hasReference && o.selection) return 'Reference';
	return 'Question';
}

/**
 * `Hebrews 11:1` from a chapter note: the chapter from the heading shaped
 * `# <Book> <n> (...)`, the verse from the closest `###### <n>` heading
 * at or above the cursor line. Null when the note is not shaped like that,
 * which is also how a capture knows the note is not a scripture chapter.
 */
export function bibleReference(noteText: string, cursorLine: number): string | null {
	const lines = noteText.split('\n');
	let chapter: string | null = null;
	for (const line of lines) {
		const m = /^#\s+(.+?\s\d+)\s*\(/.exec(line);
		if (m) chapter = m[1] as string;
	}
	if (!chapter) return null;
	for (let i = Math.min(cursorLine, lines.length - 1); i >= 0; i--) {
		const m = /^######\s+(\d+)\s*$/.exec(lines[i] ?? '');
		if (m) return `${chapter}:${m[1] as string}`;
	}
	return null;
}

/** Front of a cloze: the sentence with the selection covered. */
export function clozeFront(context: string, selection: string): string {
	const sel = selection.trim();
	const ctx = context.trim();
	if (!sel || !ctx.includes(sel)) return `[...]`;
	return ctx.replace(sel, '[...]');
}

/**
 * What a card becomes when saved: an empty front on a short selection turns into
 * a cloze; an empty front on a long one is refused (returns the error message and
 * which field the capture window should focus).
 */
export function resolveOnSave(o: { type: CardType; front: string; back: string; context: string }):
	| { type: CardType; front: string; back: string }
	| { error: string; focus: 'front' | 'back' } {
	const front = o.front.trim();
	const back = o.back.trim();
	if (!back && clozes(front).length) return { type: 'Cloze', front, back: '' };
	if (!back) return { error: 'The back is empty.', focus: 'back' };
	if (front) return { type: o.type, front, back };
	if (wordCount(back) <= CLOZE_MAX_WORDS && o.context.trim()) {
		return { type: 'Cloze', front: clozeFront(o.context, back), back };
	}
	return { error: 'Write the question: a cloze only covers a short excerpt (up to 8 words).', focus: 'front' };
}

const ALT_RE = /\s*\(([A-Ea-e])\)\s*/g;

/**
 * Puts each alternative of a question on its own paragraph:
 * `statement (A) x (B) y` becomes `statement\n\n(A) x\n\n(B) y`.
 * Only when there are at least two alternatives; otherwise the text stays.
 */
export function splitAlternatives(text: string): string {
	const found = text.match(ALT_RE);
	if (!found || found.length < 2) return text;
	return text
		.replace(ALT_RE, (_m, letter: string) => `\n\n(${letter.toUpperCase()}) `)
		.replace(/^\n+/, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}
