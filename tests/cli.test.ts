import { describe, expect, it } from 'vitest';
import { CliError, flag, need, parseBatch, PT_ALIASES, short, statusFilter, unescape } from '../src/cli/args';

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
	it('parseBatch lê os blocos e zera os ids', () => {
		const cards = parseBatch('Frente: A\nVerso: B\nTipo: Pergunta\n---\nFrente: C\nVerso: D\nTipo: Lacuna\nFonte: [[x]] ^labcde');
		expect(cards).toHaveLength(2);
		expect(cards.every((c) => c.id === null)).toBe(true);
		expect(cards[1]?.type).toBe('Lacuna');
	});
	it('parseBatch recusa arquivo sem cartões', () => {
		expect(() => parseBatch('nada aqui')).toThrow(CliError);
	});
});

describe('aliases da CLI', () => {
	it('cada comando antigo em português tem um comando em inglês como alias exato', () => {
		expect(PT_ALIASES).toEqual({ hoje: 'today', cartoes: 'cards', ver: 'show', novo: 'new', lote: 'batch', editar: 'edit', suspender: 'suspend', revisar: 'review' });
	});
	it('statusFilter lê os valores novos em inglês e os antigos em português', () => {
		expect(statusFilter({ estado: 'new' })).toBe('new');
		expect(statusFilter({ estado: 'learning' })).toBe('learning');
		expect(statusFilter({ estado: 'review' })).toBe('review');
		expect(statusFilter({ estado: 'suspended' })).toBe('suspended');
		expect(statusFilter({ estado: 'novo' })).toBe('new');
		expect(statusFilter({ estado: 'aprendendo' })).toBe('learning');
		expect(statusFilter({ estado: 'revisao' })).toBe('review');
		expect(statusFilter({ estado: 'suspenso' })).toBe('suspended');
		expect(statusFilter({ estado: 'REVISAO' })).toBe('review');
		expect(statusFilter({})).toBeUndefined();
		expect(statusFilter({ estado: '' })).toBeUndefined();
		expect(statusFilter({ estado: 'lixo' })).toBe('lixo');
	});
	it('flag aceita yes além de true, 1 e sim', () => {
		expect(flag({ dry: 'yes' }, 'dry')).toBe(true);
	});
});
