import { describe, expect, it } from 'vitest';
import { parseEstadoText, parseLogLines } from '../src/store/parse';

describe('parseEstadoText', () => {
	it('lê um estado válido', () => {
		const s = parseEstadoText('{"labcde":{"st":"ativo"},"nota:/caminho/Nota.md":{"st":"ativo"}}');
		expect(s['labcde']?.st).toBe('ativo');
		expect(Object.keys(s)).toHaveLength(2);
	});
	it('estado truncado ou estranho devolve erro ao chamador, não meia configuração', () => {
		expect(() => parseEstadoText('{"labcde":{"st":"ati')).toThrow();
		expect(() => parseEstadoText('[]')).toThrow();
		expect(() => parseEstadoText('null')).toThrow();
	});
});

describe('parseLogLines', () => {
	const line = '{"id":"labcde","t":"2026-11-03T10:00:00Z","nota":3,"segundos":10,"tipo":"Pergunta","novo":false,"extra":false}';
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
