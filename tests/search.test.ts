import { describe, expect, it } from 'vitest';
import { cardSnippet, findSnippet } from '../src/view/search';

describe('search', () => {
	it('finds without accents and keeps the original text', () => {
		expect(findSnippet('Ora, a fé é a certeza', 'fe')).toEqual({ before: 'Ora, a ', hit: 'fé', after: ' é a certeza' });
		expect(findSnippet('Ação', 'acao')?.hit).toBe('Ação');
		expect(findSnippet('nada', 'fe')).toBe(null);
	});
	it('cuts long text around the match', () => {
		const s = findSnippet('palavra '.repeat(20) + 'alvo ' + 'resto '.repeat(20), 'alvo', 20);
		expect(s?.before.startsWith('…')).toBe(true);
		expect(s?.after.endsWith('…')).toBe(true);
		expect(s?.hit).toBe('alvo');
	});
	it('says which field matched', () => {
		const c = { frente: 'Hebreus 11:1', verso: 'Ora, a fé é a certeza', assuntos: ['Hebreus'], fonte: '' };
		expect(cardSnippet(c, 'fe')?.field).toBe('Verso');
		expect(cardSnippet(c, 'hebreus')?.field).toBe('Frente');
	});
});
