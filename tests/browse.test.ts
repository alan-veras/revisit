import { describe, expect, it } from 'vitest';
import { browseOrder } from '../src/core/browse';
import { DeckRow } from '../src/core/decks';
import { State } from '../src/core/scheduler';

const row = (key: string, today: boolean, day: number | null): DeckRow => ({ key, front: key, state: day === null ? State.New : State.Review, today, due: day === null ? null : new Date(2026, 10, day), memory: null });

describe('browseOrder', () => {
	const rows = [row('new1', false, null), row('later', false, 30), row('today-new', true, null), row('soon', false, 27), row('new2', false, null), row('today-due', true, 26)];

	it('puts today first, then by due date, new cards last, ties as they came', () => {
		expect(browseOrder(rows).map((r) => r.key)).toEqual(['today-new', 'today-due', 'soon', 'later', 'new1', 'new2']);
	});

	it('does not change the array it receives', () => {
		const before = rows.map((r) => r.key);
		expect(browseOrder(rows)).not.toBe(rows);
		expect(rows.map((r) => r.key)).toEqual(before);
		expect(browseOrder([])).toEqual([]);
	});
});
