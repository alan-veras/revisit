import { describe, expect, it } from 'vitest';
import { appendCard, clozes, deckFor, deckPath, ensureIds, hideCloze, linkPath, newId, parseBlock, parseCardFile, removeCard, replaceCard, resolveOnSave, serializeCard, sourceLink, splitBlocks } from '../src/core/format';

const FILE = `Front: What is 2 + 2?
Back: 4
Type: Question
Topic: Math > Basics ^laaaaa

---

Front: Capital of Ceará?
Back:
Fortaleza
and more
Type: Question
Tags: #important
Source: [[Notes/Geo|Geo]] ^lbbbbb

---

Front:
\`\`\`
---
\`\`\`
Back: fence
Type: Question ^lccccc
`;

describe('blocks and cards', () => {
	it('splits on --- outside fences', () => {
		expect(splitBlocks(FILE)).toHaveLength(3);
	});
	it('parses fields, id, topics, tags and source', () => {
		const [a, b] = parseCardFile(FILE);
		expect(a).toMatchObject({ id: 'laaaaa', front: 'What is 2 + 2?', back: '4', topics: ['Math > Basics'] });
		expect(b).toMatchObject({ id: 'lbbbbb', back: 'Fortaleza\nand more', tags: ['important'], source: '[[Notes/Geo|Geo]]' });
	});
	it('round-trips every block as written', () => {
		for (const block of splitBlocks(FILE)) {
			const card = parseBlock(block);
			expect(serializeCard(card!)).toBe(block.lines.join('\n').trim());
		}
	});
	it('keeps types the UI no longer offers, and Reverse', () => {
		const text = 'Front: John 3:16\nBack: For God so loved\nType: Reference\nReverse: yes ^lddddd';
		const card = parseCardFile(text)[0]!;
		expect(card).toMatchObject({ type: 'Reference', reverse: true });
		expect(serializeCard(card)).toBe(text);
	});
	it('a back line that looks like a label stays inside the field', () => {
		const block = serializeCard({ id: null, type: 'Question', front: 'q', back: 'a\nSource: x', topics: [], source: '' });
		expect(parseCardFile(block)[0]!.back).toBe('a\n Source: x');
	});
	it('appends, replaces and removes a card', () => {
		const added = appendCard(FILE, 'Front: n\nBack: m\nType: Question ^leeeee');
		expect(parseCardFile(added)).toHaveLength(4);
		const first = parseCardFile(added)[0]!;
		expect(parseCardFile(replaceCard(added, first, serializeCard({ ...first, back: '5' })))[0]!.back).toBe('5');
		const removed = removeCard(added, parseCardFile(added)[1]!);
		expect(parseCardFile(removed).map((c) => c.id)).toEqual(['laaaaa', 'lccccc', 'leeeee']);
	});
	it('gives an id only to cards without one', () => {
		const taken = new Set<string>();
		const { text, added } = ensureIds('Front: a\nBack: b\nType: Question\n\n---\n\nFront: c\nBack: d\nType: Question ^lfffff\n', taken);
		expect(added).toBe(1);
		expect(parseCardFile(text).every((c) => c.id)).toBe(true);
		expect(newId(new Set(['lfffff']), () => 0)).toMatch(/^l[a-z0-9]{5}$/);
	});
});

describe('cloze, links and decks', () => {
	it('hides one highlight at a time', () => {
		expect(clozes('A ==b== and ==c==')).toEqual(['b', 'c']);
		expect(hideCloze('A ==b== and ==c==', 1)).toBe('A b and ___');
	});
	it('builds deck paths and source links', () => {
		expect(deckPath(['A > B: c'], 'Revisit')).toBe('Revisit/A/B- c.md');
		expect(deckPath([], 'Revisit/')).toBe('Revisit/Inbox.md');
		expect(sourceLink('Notes/Geo.md')).toBe('[[Notes/Geo|Geo]]');
		expect(sourceLink('a/b.pdf', 3)).toBe('[[a/b.pdf#page=3|b, p. 3]]');
		expect(linkPath('[[Notes/Geo#Sec|Geo]]')).toBe('Notes/Geo');
	});
});

describe('resolveOnSave', () => {
	it('keeps a normal card as a question', () => {
		expect(resolveOnSave({ front: 'q', back: 'a', context: '' })).toEqual({ type: 'Question', front: 'q', back: 'a' });
	});
	it('empty front on a short selection becomes a cloze of its sentence', () => {
		expect(resolveOnSave({ front: '', back: 'Fortaleza', context: 'The capital is Fortaleza.' })).toEqual({ type: 'Cloze', front: 'The capital is [...].', back: 'Fortaleza' });
	});
	it('refuses a long selection without a front, and an empty back', () => {
		expect(resolveOnSave({ front: '', back: 'one two three four five six seven eight nine', context: 'x' })).toMatchObject({ focus: 'front' });
		expect(resolveOnSave({ front: 'q', back: '', context: '' })).toMatchObject({ focus: 'back' });
	});
	it('highlights without a back make a cloze', () => {
		expect(resolveOnSave({ front: 'A ==b==', back: '', context: '' })).toMatchObject({ type: 'Cloze' });
	});
});

describe('deckFor', () => {
	it('takes the top-level folder, so Luke and John land in one deck', () => {
		expect(deckFor('2_The Bible/NT/Luke/Luke 1.md')).toBe('2_The Bible');
		expect(deckFor('2_The Bible/NT/John/John 3.md')).toBe('2_The Bible');
	});
	it('takes the note name at the root and nothing without a note', () => {
		expect(deckFor('Ideas.md')).toBe('Ideas');
		expect(deckFor(null)).toBe('');
	});
});
