/** Without accents and case, so `fe` finds `fé`. */
export function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

/** Does the query show up in any field of the card, without accents and case? Empty query matches everything. */
export function matchesCard(c: { front: string; back: string; topics: string[]; source: string }, q: string): boolean {
	const needle = fold(q.trim());
	if (!needle) return true;
	return [c.front, c.back, c.topics.join('; '), c.source].some((t) => fold(t).includes(needle));
}
