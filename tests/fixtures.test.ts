import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCardFile, serializeCard, splitBlocks } from '../src/core/format';
import { buildItems } from '../src/core/queue';
import { parseLogLines, parseStateText } from '../src/store/data';

// copies of a real 0.6.1 folder: never edited
const dir = join(__dirname, 'fixtures');
const read = (name: string) => readFileSync(join(dir, name), 'utf8');
const cardFiles = readdirSync(join(dir, 'Teste')).map((f) => join('Teste', f));

describe('0.6.1 data', () => {
	it('has card files to test', () => {
		expect(cardFiles.length).toBeGreaterThan(0);
	});
	it.each(cardFiles)('card file %s round-trips block by block', (file) => {
		const text = read(file);
		const blocks = splitBlocks(text);
		expect(parseCardFile(text)).toHaveLength(blocks.length);
		for (const block of blocks) {
			const card = parseCardFile(block.lines.join('\n'))[0]!;
			expect(serializeCard(card)).toBe(block.lines.join('\n').trim());
		}
	});
	it('reads state.json and its backup', () => {
		const state = parseStateText(read('state.json'));
		expect(Object.keys(state).length).toBeGreaterThan(0);
		expect(Object.values(state).every((s) => s.fsrs || s.st === 'suspended')).toBe(true);
		expect(Object.keys(parseStateText(read('state.backup.json'))).length).toBeGreaterThan(0);
	});
	it('writes state.json back byte for byte, unknown fields included', () => {
		const text = read('state.json').trim();
		expect(JSON.stringify(parseStateText(text))).toBe(text);
		const extra = '{"lx":{"st":"active","reread":{"n":1},"fsrs":{"due":"2026-01-01T00:00:00.000Z","state":2,"future":[1]}}}';
		expect(JSON.stringify(parseStateText(extra))).toBe(extra);
	});
	it('reads every line of the log, English or Portuguese', () => {
		const text = read('review-log.jsonl');
		const { entries, bad } = parseLogLines(text);
		expect(bad).toBe(0);
		expect(entries).toHaveLength(text.split('\n').filter(Boolean).length);
		expect(entries.every((e) => e.id && e.grade >= 1 && e.grade <= 4 && e.type)).toBe(true);
	});
	it('every card of the folder has a state entry or is new, and builds items', () => {
		const cards = cardFiles.flatMap((f) => parseCardFile(read(f)));
		const items = buildItems(cards, parseStateText(read('state.json')));
		expect(items).toHaveLength(cards.length);
	});
});
