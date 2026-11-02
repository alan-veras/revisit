import { describe, expect, it } from 'vitest';
import { checkCloze, normalizeAnswer, questaoLetra } from '../src/review/answer';

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
	it('reads the right letter of a question', () => {
		expect(questaoLetra('(C) porque a árvore...')).toBe('c');
		expect(questaoLetra('Gabarito: B. Explicação')).toBe('b');
		expect(questaoLetra('Letra e, porque')).toBe('e');
		expect(questaoLetra('D) a pilha')).toBe('d');
		expect(questaoLetra('sem letra aqui')).toBe(null);
	});
});
