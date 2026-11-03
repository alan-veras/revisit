import { describe, expect, it } from 'vitest';
import { checkCloze, hintWords, normalizeAnswer } from '../src/review/answer';

describe('hintWords', () => {
	it('gives the first words, skipping verse numbers and marks', () => {
		const verso = '<sup>4</sup> Mesmo quando eu andar\n<sup>5</sup> **Preparas** um banquete';
		expect(hintWords(verso, 3)).toBe('Mesmo quando eu…');
		expect(hintWords(verso, 5)).toBe('Mesmo quando eu andar Preparas…');
		expect(hintWords('**4** Ora, a fé', 1)).toBe('Ora,…');
	});
	it('shows the whole text without … when n covers it, and nothing for n = 0', () => {
		expect(hintWords('Jesus chorou.', 9)).toBe('Jesus chorou.');
		expect(hintWords('Jesus chorou.', 0)).toBe('');
		expect(hintWords('', 3)).toBe('');
	});
});

describe('answer', () => {
	it('normalizes accents and case', () => {
		expect(normalizeAnswer('  Fé  é ')).toBe('fe e');
	});
	it('ignores punctuation and reads the hyphen as space', () => {
		expect(normalizeAnswer('Certeza.')).toBe('certeza');
		expect(normalizeAnswer('bem-feito')).toBe('bem feito');
		expect(checkCloze('certeza daquilo que esperamos', 'Certeza daquilo que esperamos!')).toBe(true);
	});
	it('checks a cloze against the back or its first line', () => {
		expect(checkCloze('certeza', 'Certeza\nHebreus 11:1')).toBe(true);
		expect(checkCloze('fe', 'Fé')).toBe(true);
		expect(checkCloze('', 'Fé')).toBe(false);
		expect(checkCloze('esperança', 'Fé')).toBe(false);
	});
});
