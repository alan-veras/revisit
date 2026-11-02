import { headingAbove } from '../cards/section';

/** A card written inside a note in the Spaced Repetition syntax. */
export interface InlineCard {
	frente: string;
	verso: string;
	reverso: boolean;
	/** heading above the card, for the source link */
	heading: string | null;
}

const FENCE_RE = /^\s*(```|~~~)/;

/**
 * Reads `frente::verso`, `frente:::verso` (both ways) and the multi-line form:
 * front lines, a line `?` (or `??`, both ways), back lines, ended by a blank line.
 * Code blocks and the frontmatter are skipped; the note is never changed.
 */
export function parseInline(text: string): InlineCard[] {
	const lines = text.split('\n');
	const out: InlineCard[] = [];
	let fence = false;
	let start = 0;
	if (lines[0]?.trim() === '---') {
		const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
		if (end > 0) start = end + 1;
	}
	for (let i = start; i < lines.length; i++) {
		const line = lines[i] as string;
		if (FENCE_RE.test(line)) fence = !fence;
		if (fence) continue;
		const single = /^(.+?)\s*(:::|::)\s*(.+)$/.exec(line);
		if (single && !/^\s*[|>]/.test(line) && !/^[\w-]+::\s/.test(line.trim())) {
			const [, f, sep, v] = single;
			out.push({ frente: clean(f as string), verso: (v as string).trim(), reverso: sep === ':::', heading: headingAbove(text, i) });
			continue;
		}
		const t = line.trim();
		if (t === '?' || t === '??') {
			let a = i - 1;
			while (a >= start && (lines[a] as string).trim() !== '' && !/^#{1,6}\s/.test(lines[a] as string)) a--;
			let b = i + 1;
			while (b < lines.length && (lines[b] as string).trim() !== '') b++;
			const frente = lines.slice(a + 1, i).join('\n').trim();
			const verso = lines.slice(i + 1, b).join('\n').trim();
			if (frente && verso) out.push({ frente: clean(frente), verso, reverso: t === '??', heading: headingAbove(text, i) });
			i = b;
		}
	}
	return out;
}

function clean(text: string): string {
	return text.replace(/^\s*[-*+]\s+/, '').trim();
}
