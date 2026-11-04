import { describe, expect, it } from 'vitest';
import { parseStateText, parseLogLines } from '../src/store/parse';

describe('parseStateText', () => {
	it('reads a valid state and migrates the old Portuguese schema', () => {
		const { state, changed } = parseStateText('{"labcde":{"st":"active"},"note:/caminho/Nota.md":{"st":"active"}}');
		expect(state['labcde']?.st).toBe('active');
		expect(Object.keys(state)).toHaveLength(2);
		expect(changed).toBe(false);
	});
	it('a truncated or odd state throws to the caller, not half a configuration', () => {
		expect(() => parseStateText('{"labcde":{"st":"ati')).toThrow();
		expect(() => parseStateText('[]')).toThrow();
		expect(() => parseStateText('null')).toThrow();
	});
});

describe('parseLogLines', () => {
	const pt = '{"id":"labcde","t":"2026-11-03T10:00:00Z","nota":3,"segundos":10,"tipo":"Pergunta","novo":false,"extra":false}';
	const en = '{"id":"labfgh","t":"2026-11-04T10:00:00Z","grade":3,"seconds":10,"type":"Pergunta","new":false,"extra":false}';
	it('reads the good lines, counts the bad ones and keeps the raw lines', () => {
		const { entries, bad, lines } = parseLogLines([pt, '{"id": truncated', '', en].join('\n'));
		expect(entries).toHaveLength(2);
		expect(bad).toBe(1);
		expect(lines).toEqual([pt, en]);
	});
	it('empty file or blank lines only', () => {
		expect(parseLogLines('')).toEqual({ entries: [], bad: 0, lines: [] });
		expect(parseLogLines('\n\n')).toEqual({ entries: [], bad: 0, lines: [] });
	});
});
