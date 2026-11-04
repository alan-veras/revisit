import { describe, expect, it } from 'vitest';
import { parseStateText, parseLogLines } from '../src/store/parse';

describe('parseStateText', () => {
	it('lê um status válido', () => {
		const s = parseStateText('{"labcde":{"st":"active"},"note:/caminho/Grade.md":{"st":"active"}}');
		expect(s['labcde']?.st).toBe('active');
		expect(Object.keys(s)).toHaveLength(2);
	});
	it('status truncado ou estranho devolve erro ao chamador, não meia configuração', () => {
		expect(() => parseStateText('{"labcde":{"st":"ati')).toThrow();
		expect(() => parseStateText('[]')).toThrow();
		expect(() => parseStateText('null')).toThrow();
	});
});

describe('parseLogLines', () => {
	const line = '{"id":"labcde","t":"2026-11-03T10:00:00Z","grade":3,"seconds":10,"type":"Pergunta","new":false,"extra":false}';
	it('lê as linhas boas e conta as ruins, sem abortar', () => {
		const { entries, bad } = parseLogLines([line, '{"id": truncado', '', line].join('\n'));
		expect(entries).toHaveLength(2);
		expect(bad).toBe(1);
	});
	it('arquivo vazio ou só linhas em branco', () => {
		expect(parseLogLines('')).toEqual({ entries: [], bad: 0 });
		expect(parseLogLines('\n\n')).toEqual({ entries: [], bad: 0 });
	});
});
