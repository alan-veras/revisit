import { describe, expect, it } from 'vitest';
import { CliError, flag, need, parseLote, short, unescape } from '../src/cli/args';

describe('args da CLI', () => {
	it('need exige o valor', () => {
		expect(need({ a: 'x' }, 'a')).toBe('x');
		expect(() => need({}, 'a')).toThrow(CliError);
		expect(() => need({ a: 'true' }, 'a')).toThrow(CliError);
	});
	it('flag aceita true, 1 e sim', () => {
		expect(flag({ dry: 'true' }, 'dry')).toBe(true);
		expect(flag({ dry: 'sim' }, 'dry')).toBe(true);
		expect(flag({}, 'dry')).toBe(false);
	});
	it('unescape troca \\n por quebra de linha', () => {
		expect(unescape('a\\nb')).toBe('a\nb');
	});
	it('short encurta numa linha', () => {
		expect(short('a\n b', 10)).toBe('a b');
		expect(short('x'.repeat(20), 10)).toHaveLength(10);
	});
	it('parseLote lê os blocos e zera os ids', () => {
		const cards = parseLote('Frente: A\nVerso: B\nTipo: Pergunta\n---\nFrente: C\nVerso: D\nTipo: Lacuna\nFonte: [[x]] ^labcde');
		expect(cards).toHaveLength(2);
		expect(cards.every((c) => c.id === null)).toBe(true);
		expect(cards[1]?.tipo).toBe('Lacuna');
	});
	it('parseLote recusa arquivo sem cartões', () => {
		expect(() => parseLote('nada aqui')).toThrow(CliError);
	});
});
