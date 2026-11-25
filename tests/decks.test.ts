import { describe, expect, it } from 'vitest';
import { groupDecks, plain } from '../src/core/decks';
import { buildItems } from '../src/core/queue';
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
