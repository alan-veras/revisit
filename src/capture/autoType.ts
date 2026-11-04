import { clozes } from '../cards/cloze';
import { CardType } from '../cards/types';

export const CLOZE_MAX_WORDS = 8;

export function wordCount(text: string): number {
	return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** The type the capture window opens with. */
export function initialType(o: { isPdf: boolean; path: string | null; selection: string }): CardType {
	if (o.isPdf && o.selection) return 'Questão';
	if (o.path?.startsWith('2_The Bible/') && o.selection) return 'Referência';
	return 'Pergunta';
}

/**
 * `Hebreus 11:1` from a Bible chapter note: the chapter from the first heading
 * shaped `# <Livro> <n> (...)`, the verse from the closest `###### <n>` heading
 * at or above the cursor line. Null when the note is not shaped like that.
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
 * a cloze; an empty front on a long one is refused (returns an error message).
 */
export function resolveOnSave(o: { type: CardType; front: string; back: string; context: string }):
	| { type: CardType; front: string; back: string }
	| { error: string } {
	const front = o.front.trim();
	const back = o.back.trim();
	if (!back && clozes(front).length) return { type: 'Lacuna', front, back: '' };
	if (!back) return { error: 'The back is empty.' };
	if (front) return { type: o.type, front, back };
	if (wordCount(back) <= CLOZE_MAX_WORDS && o.context.trim()) {
		return { type: 'Lacuna', front: clozeFront(o.context, back), back };
	}
	return { error: 'Write the question: a cloze only works for a short excerpt.' };
}

const ALT_RE = /\s*\(([A-Ea-e])\)\s*/g;

/**
 * Puts each alternative of a question on its own paragraph:
 * `enunciado (A) x (B) y` becomes `enunciado\n\n(A) x\n\n(B) y`.
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
