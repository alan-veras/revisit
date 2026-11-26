import { describe, expect, it } from 'vitest';
import { childDecks, crumbs, deckOf, groupDecks, inDeck, nearestDeck, plain, subdeckName } from '../src/core/decks';
import { buildItems, buildQueue, itemsFor } from '../src/core/queue';
import { freshCard, toStored } from '../src/core/scheduler';
import { Card, CardState } from '../src/core/types';

const now = new Date(2026, 10, 25, 9, 0, 0);
const card = (id: string, file: string, extra: Partial<Card> = {}): Card => ({ id, type: 'Question', front: `q ${id}`, back: 'a', topics: [], source: '', start: 0, end: 0, file, ...extra });
const seen = (state: number, dueMin: number): CardState => ({ st: 'active', fsrs: toStored({ ...freshCard(now), state, due: new Date(now.getTime() + dueMin * 60000), last_review: now, stability: 3, difficulty: 5, reps: 1 }) });

describe('decks', () => {
	it('groups cards by file, counts states and today, and sorts by name', () => {
		const cards = [card('la', 'Revisit/Teste/AWS.md'), card('lb', 'Revisit/Teste/AWS.md'), card('lc', 'Revisit/Bíblia.md'), card('ld', 'Revisit/Bíblia.md')];
		const state = { lb: seen(2, -5), lc: seen(1, 6), ld: { ...seen(2, 60 * 48), st: 'suspended' as const } };
		const d = groupDecks(buildItems(cards, state), 'Revisit', new Set(['la', 'lb']), now, () => 0.9);
		expect(d.map((x) => [x.name, x.folder])).toEqual([['AWS', 'Teste'], ['Bíblia', '']]);
		expect(d[0]?.counts).toEqual({ new: 1, learning: 0, review: 1 });
		expect(d[0]?.today).toBe(2);
		expect(d[1]?.counts).toEqual({ new: 0, learning: 1, review: 0 });
		expect(d[1]?.rows).toHaveLength(1);
		expect(d[0]?.rows[0]?.memory).toBeNull();
		expect(d[0]?.rows[1]?.memory).toBe(0.9);
	});

	it('shows a cloze with its blank and strips markdown marks', () => {
		const items = buildItems([card('lz', 'Revisit/B.md', { type: 'Cloze', front: 'O Senhor é o meu ==pastor==', back: '' })], {});
		expect(groupDecks(items, 'Revisit', new Set(), now, () => 1)[0]?.rows[0]?.front).toBe('O Senhor é o meu ___');
		expect(plain('**Hebreus** [[Fé|fé]] `x`\n- item')).toBe('Hebreus fé x item');
	});
});

describe('subdecks by folder', () => {
	const files = ['R/AWS.md', 'R/AWS/EC2.md', 'R/AWS/EC2/AMI.md', 'R/AWSome.md', 'R/Teste/Geral.md'];
	const paths = files.map((f) => deckOf(f, 'R'));
	const items = buildItems(files.map((f, i) => card(`l${i}`, f)), {});

	it('takes the deck from the path inside the folder', () => {
		expect(paths).toEqual(['AWS', 'AWS/EC2', 'AWS/EC2/AMI', 'AWSome', 'Teste/Geral']);
		expect(deckOf('A/B/Deck.md', 'A/B')).toBe('Deck');
	});

	it('a deck holds itself and what is below, not a name that only starts alike', () => {
		expect(['AWS', 'AWS/EC2', 'AWS/EC2/AMI', 'AWSome'].map((p) => inDeck(p, 'AWS'))).toEqual([true, true, true, false]);
	});

	it('lists the immediate subdecks once, file and folder as one, folders without a file too', () => {
		expect(childDecks([...paths, 'AWS'], '').map((d) => d.path)).toEqual(['AWS', 'AWSome', 'Teste']);
		expect(childDecks(paths, 'AWS')).toEqual([{ path: 'AWS/EC2', name: 'EC2' }]);
		expect(childDecks(paths, 'AWS/EC2')).toEqual([{ path: 'AWS/EC2/AMI', name: 'AMI' }]);
		expect(childDecks(paths, 'AWSome')).toEqual([]);
	});

	it('filters items by subtree', () => {
		expect(itemsFor(items, 'AWS', 'R').map((it) => it.key)).toEqual(['l0', 'l1', 'l2']);
		expect(itemsFor(items, 'Teste', 'R').map((it) => it.key)).toEqual(['l4']);
		expect(itemsFor(items, null, 'R')).toHaveLength(5);
	});

	it('shares the daily cap of new cards with the other decks', () => {
		const log = Array.from({ length: 9 }, (_, i) => ({ id: `other${i}`, t: now.toISOString(), grade: 3, seconds: 1, type: 'Question', new: true, extra: false }));
		expect(buildQueue(itemsFor(items, 'AWS', 'R'), { now, log, retrievability: () => 1 })).toHaveLength(1);
	});

	it('climbs to the closest ancestor of a deck that is gone', () => {
		expect(nearestDeck(paths, 'AWS/EC2/Gone')).toBe('AWS/EC2');
		expect(nearestDeck(paths, 'Gone/Deeper')).toBe('');
		expect(nearestDeck(paths, 'Teste')).toBe('Teste');
	});

	it('draws a breadcrumb from the second level, shortened when long', () => {
		expect(crumbs('AWS')).toEqual([]);
		expect(crumbs('AWS/EC2').map((c) => c.label)).toEqual(['Decks', 'AWS']);
		expect(crumbs('a/b/c').map((c) => c.path)).toEqual(['', 'a', 'a/b']);
		expect(crumbs('a/b/c/d')).toEqual([{ label: '…', path: 'a/b' }, { label: 'c', path: 'a/b/c' }]);
	});

	it('makes a typed name safe', () => {
		expect(subdeckName(' a:b_c"d<e>f|g?h*i\\j/k;l ')).toBe('a-b-c-d-e-f-g-h-i-j-k-l');
		expect(subdeckName(' .. ')).toBe('');
	});
});
