import { createEmptyCard, State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { catchUpPlan, forecastMinutes, ForecastCard, sustainability } from '../src/srs/forecast';

const NOW = new Date(2026, 10, 5, 10, 0, 0);
const SECS = { Q: 60, A: 10 };

function card(key: string, type: string, dueInDays: number, extra: Partial<ForecastCard> = {}, stability = 10): ForecastCard {
	const f = createEmptyCard(NOW);
	f.state = State.Review;
	f.stability = stability;
	f.due = new Date(2026, 10, 5 + dueInDays, 8, 0, 0);
	f.last_review = new Date(2026, 9, 1);
	return { key, type, fsrs: f, ...extra };
}

describe('forecastMinutes', () => {
	it('sums seconds of each type per day, overdue counts today', () => {
		const cards = [card('a', 'Q', 1), card('b', 'A', 1), card('c', 'A', -5), card('d', 'Q', 3)];
		const f = forecastMinutes(cards, SECS, NOW);
		expect(f.perDay).toHaveLength(30);
		expect(f.perDay[0]).toBeCloseTo(0.2, 1);
		expect(f.tomorrow).toBeCloseTo(1.2, 1);
		expect(f.next7).toBeCloseTo(2.4, 1);
		expect(f.peak).toEqual({ day: 1, minutes: 1.2 });
	});

	it('ignores new, suspended, pending and out-of-range cards', () => {
		const n = card('n', 'Q', 1);
		(n.fsrs as { state: State }).state = State.New;
		const cards = [n, card('s', 'Q', 1, { suspended: true }), card('p', 'Q', 1, { pending: true }), card('far', 'Q', 40)];
		const f = forecastMinutes(cards, SECS, NOW);
		expect(f.next7).toBe(0);
		expect(f.peak).toEqual({ day: 0, minutes: 0 });
	});
});

describe('sustainability', () => {
	const cards = Array.from({ length: 60 }, (_, i) => card(`k${i}`, 'A', 2, {}, 10));

	it('adds the cost of new cards and what-if', () => {
		const s = sustainability(cards, SECS, { newPerDay: 5, extraNew: 5, budgetMinutes: 20 });
		expect(s.baseMinutes).toBe(1);
		expect(s.currentMinutes).toBeGreaterThan(s.baseMinutes);
		expect(s.whatIfMinutes).toBeGreaterThan(s.currentMinutes);
	});

	it('labels against the budget', () => {
		const light = sustainability(cards, SECS, { newPerDay: 0, extraNew: 0, budgetMinutes: 20 });
		expect(light.label).toBe('Light');
		const heavy = sustainability(cards, SECS, { newPerDay: 5, extraNew: 100, budgetMinutes: 20 });
		expect(heavy.label).toBe('Light');
		expect(heavy.whatIfLabel).toBe('Heavy');
		expect(sustainability(cards, SECS, { newPerDay: 5, extraNew: 0, budgetMinutes: 2 }).label).toBe('Heavy');
		expect(sustainability(cards, SECS, { newPerDay: 5, extraNew: 0, budgetMinutes: 10 }).label).toBe('Sustainable');
	});
});

describe('catchUpPlan', () => {
	it('spreads the backlog within the budget, important then lowest retrievability first', () => {
		const backlog = [
			card('low', 'Q', -10),
			card('mid', 'Q', -5),
			card('imp', 'Q', -1, { tags: ['important'] }),
			card('hi', 'Q', -2),
		];
		const r: Record<string, number> = { low: 0.2, mid: 0.5, hi: 0.8, imp: 0.9 };
		const plan = catchUpPlan(backlog, SECS, {
			now: NOW,
			budgetMinutes: 2,
			retrievability: (c) => r[backlog.find((b) => b.fsrs === c)?.key as string] as number,
		});
		expect(plan.overdue).toBe(4);
		expect(plan.days.map((d) => d.keys)).toEqual([['imp', 'low'], ['mid', 'hi']]);
		expect(plan.days.every((d) => d.minutes <= 2)).toBe(true);
		expect(plan.unplaced).toEqual([]);
	});

	it('counts cards already due against the day and reports what does not fit', () => {
		const cards = [card('due0', 'Q', 0), card('o1', 'Q', -3), card('o2', 'Q', -3)];
		const plan = catchUpPlan(cards, SECS, { now: NOW, budgetMinutes: 2, horizonDays: 1 });
		expect(plan.days[0]?.keys).toHaveLength(1);
		expect(plan.unplaced).toHaveLength(1);
	});

	it('still places one card on a day when a single card exceeds the budget', () => {
		const plan = catchUpPlan([card('big', 'Q', -2)], SECS, { now: NOW, budgetMinutes: 0.5 });
		expect(plan.days[0]?.keys).toEqual(['big']);
	});
});
