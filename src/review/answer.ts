/** Typed answers: compared without accents, case or extra spaces. */
export function normalizeAnswer(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[*_`=]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** A cloze answer is right when it matches the back, or its first line. */
export function checkCloze(typed: string, verso: string): boolean {
	const t = normalizeAnswer(typed);
	if (!t) return false;
	const full = normalizeAnswer(verso);
	const first = normalizeAnswer(verso.split('\n')[0] ?? '');
	return t === full || t === first;
}

