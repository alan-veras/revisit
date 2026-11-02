import { describe, expect, it } from 'vitest';
import { checkCloze, normalizeAnswer } from '../src/review/answer';

describe('answer', () => {
	it('normalizes accents and case', () => {
		expect(normalizeAnswer('  Fé  é ')).toBe('fe e');
	});
	it('checks a cloze against the back or its first line', () => {
		expect(checkCloze('certeza', 'Certeza\nHebreus 11:1')).toBe(true);
		expect(checkCloze('fe', 'Fé')).toBe(true);
		expect(checkCloze('', 'Fé')).toBe(false);
		expect(checkCloze('esperança', 'Fé')).toBe(false);
	});
});
