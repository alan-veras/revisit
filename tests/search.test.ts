import { describe, expect, it } from 'vitest';
import { fold, matchesCard } from '../src/view/search';

describe('search', () => {
	it('folds without accents and case', () => {
		expect(fold('Ação É')).toBe('acao e');
	});
	it('finds the query in any field, without accents and case', () => {
		const c = { frente: 'Hebreus 11:1', verso: 'Ora, a fé é a certeza', assuntos: ['Sustento > Perseguição'], fonte: '[[2_The Bible/NT/Hebrews/Heb 11|Heb 11]]' };
		expect(matchesCard(c, 'fe')).toBe(true);
		expect(matchesCard(c, 'PERSEGUICAO')).toBe(true);
		expect(matchesCard(c, 'heb 11')).toBe(true);
		expect(matchesCard(c, 'kubernetes')).toBe(false);
	});
	it('empty query matches everything', () => {
		expect(matchesCard({ frente: '', verso: '', assuntos: [], fonte: '' }, '  ')).toBe(true);
	});
});
