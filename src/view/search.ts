/** Without accents and case, so `fe` finds `fé`. */
export function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

/** Does the query show up in any field of the card, without accents and case? Empty query matches everything. */
export function matchesCard(c: { frente: string; verso: string; assuntos: string[]; fonte: string }, q: string): boolean {
	const needle = fold(q.trim());
	if (!needle) return true;
	return [c.frente, c.verso, c.assuntos.join('; '), c.fonte].some((t) => fold(t).includes(needle));
}
