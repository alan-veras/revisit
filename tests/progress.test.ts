import { State } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { Card } from '../src/cards/types';
import { DEFAULT_SECS, forecast, RevlogEntry } from '../src/srs/budget';
import { newPerWeek, retentionBy, reviewsPerDay } from '../src/srs/stats';

const NOW = new Date('2026-11-02T10:00:00');
const card = (id: string, topics: string[] = [], over: Partial<Card> = {}): Card => ({ id, type: 'Pergunta', front: `f ${id}`, back: `v ${id}`, topics, source: '', start: 0, end: 0, ...over });
const at = (d: number) => new Date(NOW.getTime() + d * 86400000);

describe('forecast', () => {
	it('counts overdue today and each card on its day', () => {
		const items = [
			{ card: card('a'), fsrs: { due: at(-3), state: State.Review }, suspended: false },
			{ card: card('b'), fsrs: { due: at(2), state: State.Review }, suspended: false },
			{ card: card('q', [], { type: 'Questão' }), fsrs: { due: at(2), state: State.Review }, suspended: false },
			{ card: card('n'), fsrs: { due: at(0), state: State.New }, suspended: false },
			{ card: card('s'), fsrs: { due: at(0), state: State.Review }, suspended: true },
		];
		expect(forecast(items, DEFAULT_SECS, NOW)).toEqual([0.2, 0, 1.2, 0, 0, 0, 0]);
	});
});

describe('stats', () => {
	const e = (id: string, d: number, grade = 3, over: Partial<RevlogEntry> = {}): RevlogEntry => ({ id, t: at(d).toISOString(), grade, seconds: 10, type: 'Pergunta', new: false, extra: false, ...over });
	it('retention only counts reviews 7 days or more after the previous one', () => {
		const log = [e('a', -20, 3, { new: true }), e('a', -19), e('a', -10, 1), e('a', -1), e('b', -2, 3, { new: true }), e('b', -1, 1)];
		expect(retentionBy(log, () => 'x').get('x')).toEqual({ ok: 1, total: 2 });
	});
	it('reviews per day and new per week', () => {
		const log = [e('a', 0, 3, { new: true }), e('a', 0), e('b', -8, 3, { new: true })];
		const d = reviewsPerDay(log, NOW, 10);
		expect(d[9]).toBe(2);
		expect(d[1]).toBe(1);
		expect(newPerWeek(log, NOW, 3)).toEqual([1, 0, 1]);
	});
});
