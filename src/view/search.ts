/** Without accents and case, so `fe` finds `fé`. */
export function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

export interface Snippet {
	/** which field matched */
	campo: 'Frente' | 'Verso' | 'Assunto' | 'Fonte';
	before: string;
	hit: string;
	after: string;
}

/**
 * Where `q` shows up in `text`, ignoring accents and case: the original words
 * around it (about `ctx` characters each side), so the match can be highlighted.
 */
export function findSnippet(text: string, q: string, ctx = 40): Omit<Snippet, 'campo'> | null {
	const needle = fold(q.trim());
	if (!needle) return null;
	const flat = text.replace(/\s+/g, ' ');
	// fold char by char, remembering where each folded char came from
	let folded = '';
	const from: number[] = [];
	for (let i = 0; i < flat.length; i++) {
		const f = fold(flat[i] as string);
		for (let k = 0; k < f.length; k++) from.push(i);
		folded += f;
	}
	const at = folded.indexOf(needle);
	if (at < 0) return null;
	const s = from[at] as number;
	const e = (from[at + needle.length - 1] as number) + 1;
	let b = Math.max(0, s - ctx);
	let a = Math.min(flat.length, e + ctx);
	// cut at word boundaries
	if (b > 0) b = flat.indexOf(' ', b) + 1 || b;
	if (a < flat.length) a = flat.lastIndexOf(' ', a) > e ? flat.lastIndexOf(' ', a) : a;
	return { before: (b > 0 ? '…' : '') + flat.slice(b, s), hit: flat.slice(s, e), after: flat.slice(e, a) + (a < flat.length ? '…' : '') };
}

/** The first field of a card that matches, in reading order. */
export function cardSnippet(c: { frente: string; verso: string; assuntos: string[]; fonte: string }, q: string): Snippet | null {
	const fields: [Snippet['campo'], string][] = [
		['Frente', c.frente],
		['Verso', c.verso],
		['Assunto', c.assuntos.join('; ')],
		['Fonte', c.fonte],
	];
	for (const [campo, text] of fields) {
		const m = findSnippet(text, q);
		if (m) return { campo, ...m };
	}
	return null;
}
