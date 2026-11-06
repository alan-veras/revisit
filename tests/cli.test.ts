import { describe, expect, it } from 'vitest';
import { CliError, flag, need, parseBatch, short, unescape } from '../src/cli/args';

describe('args da CLI', () => {
	it('need exige o valor', () => {
		expect(need({ a: 'x' }, 'a')).toBe('x');
		expect(() => need({}, 'a')).toThrow(CliError);
		expect(() => need({ a: 'true' }, 'a')).toThrow(CliError);
	});
	it('flag aceita true, 1 e yes', () => {
		expect(flag({ dry: 'true' }, 'dry')).toBe(true);
		expect(flag({ dry: 'yes' }, 'dry')).toBe(true);
		expect(flag({}, 'dry')).toBe(false);
	});
	it('unescape troca \\n por quebra de linha', () => {
		expect(unescape('a\\nb')).toBe('a\nb');
	});
	it('short encurta numa linha', () => {
		expect(short('a\n b', 10)).toBe('a b');
		expect(short('x'.repeat(20), 10)).toHaveLength(10);
	});
	it('parseBatch lê os blocos e zera os ids', () => {
		const cards = parseBatch('Front: A\nBack: B\nType: Question\n---\nFront: C\nBack: D\nType: Cloze\nSource: [[x]] ^labcde');
		expect(cards).toHaveLength(2);
		expect(cards.every((c) => c.id === null)).toBe(true);
		expect(cards[1]?.type).toBe('Cloze');
	});
	it('parseBatch recusa arquivo sem cartões', () => {
		expect(() => parseBatch('nada aqui')).toThrow(CliError);
	});
});
