import { describe, expect, it } from 'vitest';
import { minutesLeft, shiftClock } from '../src/core/pause';

describe('shiftClock', () => {
	it('moves every moment by the paused time, keeping what had passed', () => {
		const before = { startedAt: 1000, endsAt: 301_000, shownAt: 50_000 };
		const after = shiftClock(before, 90_000);
		expect(after).toEqual({ startedAt: 91_000, endsAt: 391_000, shownAt: 140_000 });
		// paused at 60 s, resumed 90 s later: the same time has passed and the card is as old
		expect(150_000 - after.shownAt).toBe(60_000 - before.shownAt);
		expect(after.endsAt - 150_000).toBe(before.endsAt - 60_000);
	});
});

describe('minutesLeft', () => {
	it('rounds up and never says zero', () => {
		expect(minutesLeft(300_000, 0)).toBe(5);
		expect(minutesLeft(300_000, 1000)).toBe(5);
		expect(minutesLeft(300_000, 299_000)).toBe(1);
		expect(minutesLeft(300_000, 400_000)).toBe(1);
	});
});
