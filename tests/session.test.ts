import { createEmptyCard, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { Card } from '../src/cards/types';
import { averageAhead, dueCounts, forecastMinutes } from '../src/srs/forecast';
import { QueueItem, QueueOptions } from '../src/srs/queue';
import { nearestChoice, sessionChoices, summarizeSession, toForecastCards } from '../src/srs/session';
import { heatLevels } from '../src/srs/stats';

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const SECS = { Question: 60, Cloze: 60, Reference: 60, Problem: 60 };

function item(n: number, dueInDays: number): QueueItem {
	const f = createEmptyCard(NOW);
	f.state = State.Review;
	f.stability = 10;
	f.due = new Date(2026, 10, 5 + dueInDays, 8, 0, 0);
	const card: Card = { id: `l${n}`, type: 'Question', front: `q${n}`, back: 'a', topics: [], source: '', start: 0, end: 0 };
	return { key: `l${n}`, reverse: false, card, source: `note${n}.md`, fsrs: f, suspended: false };
}

const base: Omit<QueueOptions, 'budgetMinutes'> = {
	now: NOW,
	newAllowed: 0,
	secs: SECS,
	interleave: false,
	retrievability: (c) => (c.due.getTime() % 1000) / 1000,
};

describe('sessionChoices', () => {
	it('counts how many cards fit each length, then everything due', () => {
		const items = Array.from({ length: 40 }, (_, i) => item(i, -1));
		const out = sessionChoices(items, base, SECS);
		expect(out.map((c) => c.minutes)).toEqual([5, 10, 20, 30, null]);
		expect(out.map((c) => c.cards)).toEqual([5, 10, 20, 30, 40]);
		expect(out[4]?.estimate).toBe(40);
	});

	it('never holds more than what is due and keeps one card in a tiny budget', () => {
		const out = sessionChoices([item(1, -1), item(2, 3)], base, { ...SECS, Question: 600 });
		expect(out.map((c) => c.cards)).toEqual([1, 1, 1, 1, 1]);
	});

	it('is empty with nothing due', () => {
		expect(sessionChoices([item(1, 2)], base, SECS).every((c) => c.cards === 0)).toBe(true);
	});
});

describe('nearestChoice', () => {
	it('picks the closest length, the lower on a tie', () => {
		expect(nearestChoice(20)).toBe(20);
		expect(nearestChoice(15)).toBe(10);
		expect(nearestChoice(25)).toBe(20);
		expect(nearestChoice(120)).toBe(30);
		expect(nearestChoice(1)).toBe(5);
	});
});

describe('summarizeSession', () => {
	it('reports cards, percent right and minutes', () => {
		const s = summarizeSession({ 1: 4, 2: 6, 3: 20, 4: 1 }, NOW.getTime(), NOW.getTime() + 19.6 * 60000);
		expect(s).toEqual({ cards: 31, percentRight: 87, minutes: 20 });
	});
	it('handles a session with no answers', () => {
		expect(summarizeSession({ 1: 0, 2: 0, 3: 0, 4: 0 }, 0, 10)).toEqual({ cards: 0, percentRight: null, minutes: 0 });
	});
	it('counts at least one minute', () => {
		expect(summarizeSession({ 1: 0, 2: 0, 3: 1, 4: 0 }, 0, 1000).minutes).toBe(1);
	});
});

describe('tomorrow and heat helpers', () => {
	it('dueCounts and averageAhead read the same cards as the forecast', () => {
		const items = [item(1, -3), item(2, 1), item(3, 1), item(4, 4)];
		const cards = toForecastCards(items);
		expect(dueCounts(cards, NOW, 7)).toEqual([1, 2, 0, 0, 1, 0, 0]);
		const f = forecastMinutes(cards, SECS, NOW);
		expect(f.tomorrow).toBe(2);
		expect(averageAhead(f)).toBeCloseTo(0.4, 1);
	});

	it('heatLevels: 0 for empty days, quartiles for the rest', () => {
		expect(heatLevels([0, 0])).toEqual([0, 0]);
		const lv = heatLevels([0, 1, 2, 3, 4, 5, 6, 7, 8, 100]);
		expect(lv[0]).toBe(0);
		expect(lv[1]).toBe(1);
		expect(lv[9]).toBe(4);
		expect(Math.max(...lv)).toBe(4);
		expect(Math.min(...lv.slice(1))).toBe(1);
	});
});

describe('niceMax', () => {
	it('rounds the chart top up to a readable step', async () => {
		const { niceMax } = await import('../src/view/charts');
		expect(niceMax(0)).toBe(10);
		expect(niceMax(27.3)).toBe(30);
		expect(niceMax(31)).toBe(40);
		expect(niceMax(1200)).toBe(1200);
	});
});
