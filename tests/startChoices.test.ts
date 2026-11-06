import { describe, expect, it } from 'vitest';
import { SessionChoice, visibleChoices } from '../src/srs/session';

const c = (minutes: number | null, cards: number, estimate = 1): SessionChoice => ({ minutes, cards, estimate });

describe('visibleChoices', () => {
	it('shows only "everything" when the shortest length already holds it all', () => {
		const all = [c(5, 20), c(10, 20), c(20, 20), c(30, 20), c(null, 20, 3)];
		expect(visibleChoices(all).map((x) => x.minutes)).toEqual([null]);
	});
	it('keeps the lengths that change the outcome, then everything', () => {
		const rows = [c(5, 9), c(10, 17), c(20, 31), c(30, 44), c(null, 83, 58)];
		expect(visibleChoices(rows).map((x) => x.minutes)).toEqual([5, 10, 20, 30, null]);
	});
	it('drops a length that holds the same as the one before it or as everything', () => {
		const rows = [c(5, 9), c(10, 9), c(20, 31), c(30, 83), c(null, 83, 58)];
		expect(visibleChoices(rows).map((x) => x.minutes)).toEqual([5, 20, null]);
	});
});
