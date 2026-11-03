/** Typed answers: compared without accents, case, punctuation or extra spaces. */
export function normalizeAnswer(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.replace(/[*_`=]/g, '')
		.replace(/[.,;:!?¡¿"'“”‘’()[\]{}<>«»…]/g, '')
		.replace(/[-–/\\]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

/**
 * The first `n` words of a back, as a hint: verse numbers (`<sup>4</sup>`, `**4**`),
 * html tags and markdown marks are left out. `…` marks that more remains.
 */
export function hintWords(verso: string, n: number): string {
	const words = verso
		.replace(/<sup>[^<]*<\/sup>/gi, ' ')
		.replace(/\*\*\d+\*\*/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[*_`=]/g, '')
		.split(/\s+/)
		.filter(Boolean);
	if (n <= 0 || !words.length) return '';
	const shown = words.slice(0, n).join(' ');
	return n < words.length ? `${shown}…` : shown;
}

/** A cloze answer is right when it matches the back, or its first line. */
export function checkCloze(typed: string, verso: string): boolean {
	const t = normalizeAnswer(typed);
	if (!t) return false;
	const full = normalizeAnswer(verso);
	const first = normalizeAnswer(verso.split('\n')[0] ?? '');
	return t === full || t === first;
}

