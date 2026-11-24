import { describe, expect, it } from 'vitest';
import { buildItems, buildQueue, burySiblings, faces, interleave, nextCardLabel } from '../src/core/queue';
import { formatInterval, freshCard, fromStored, Scheduler, toStored } from '../src/core/scheduler';
import { Card, CardState, RevlogEntry } from '../src/core/types';

const now = new Date(2026, 10, 24, 12, 0, 0);
const sched = new Scheduler(0.9);
const card = (id: string, extra: Partial<Card> = {}): Card => ({ id, type: 'Question', front: `q ${id}`, back: `a ${id}`, topics: [], source: '', start: 0, end: 0, ...extra });
const reviewed = (due: Date): CardState => ({ st: 'active', fsrs: toStored({ ...freshCard(now), state: 2, due, stability: 5, difficulty: 5, reps: 2 }) });
const at = (days: number) => new Date(now.getTime() + days * 86400000);
const queue = (cards: Card[], state: Record<string, CardState>, log: RevlogEntry[] = []) => buildQueue(buildItems(cards, state), { now, log, retrievability: (c, n) => sched.retrievability(c, n) });
const entry = (id: string, isNew: boolean): RevlogEntry => ({ id, t: now.toISOString(), grade: 3, seconds: 5, type: 'Question', new: isNew, extra: false });

describe('queue', () => {
	it('counts a cloze with several highlights once against the daily cap', () => {
		const cloze = card('lclz001', { type: 'Cloze', front: '==a== ==b== ==c==', back: '' });
		const others = Array.from({ length: 10 }, (_, i) => card(`lnew00${i}`));
		const q = queue([cloze, ...others], {});
		expect(q).toHaveLength(10);
		expect(q.filter((i) => i.card.id === 'lclz001')).toHaveLength(1);
	});
	it('puts due reviews before new cards and leaves future ones out', () => {
		const q = queue([card('lnew001'), card('ldue001'), card('lfut001')], { ldue001: reviewed(at(-1)), lfut001: reviewed(at(3)) });
		expect(q.map((i) => i.key)).toEqual(['ldue001', 'lnew001']);
	});
	it('lets 10 new cards in per day, counting the ones already introduced', () => {
		const cards = Array.from({ length: 15 }, (_, i) => card(`lnew${String(i).padStart(3, '0')}`));
		expect(queue(cards, {})).toHaveLength(10);
		const log = [entry('lx1', true), entry('lx2', true), entry('lx3', false)];
		expect(queue(cards, {}, log)).toHaveLength(8);
	});
	it('skips suspended cards', () => {
		expect(queue([card('lsus001')], { lsus001: { st: 'suspended', fsrs: reviewed(at(-1)).fsrs! } })).toHaveLength(0);
	});
	it('asks each highlight of a cloze and keeps only one of them per day', () => {
		const cloze = card('lclo001', { type: 'Cloze', front: 'A ==b== and ==c==', back: 'extra' });
		const items = buildItems([cloze], {});
		expect(items.map((i) => i.key)).toEqual(['lclo001', 'lclo001-c2']);
		expect(faces(items[1]!)).toEqual({ front: 'A b and ___', back: 'c\n\nextra' });
		expect(queue([cloze], {})).toHaveLength(1);
		expect(burySiblings(items, new Set(['lclo001-c2'])).map((i) => i.key)).toEqual(['lclo001-c2']);
	});
	it('shows cards of removed types as question and answer, and ignores Reverse', () => {
		const items = buildItems([card('lref001', { type: 'Reference', reverse: true })], {});
		expect(items).toHaveLength(1);
		expect(faces(items[0]!)).toEqual({ front: 'q lref001', back: 'a lref001' });
	});
	it('mixes topics round robin', () => {
		const items = buildItems([card('la00001', { topics: ['A'] }), card('la00002', { topics: ['A'] }), card('lb00001', { topics: ['B'] })], {});
		expect(interleave(items).map((i) => i.key)).toEqual(['la00001', 'lb00001', 'la00002']);
	});
});

describe('next card label', () => {
	it('says tomorrow or in N days, or nothing', () => {
		const label = (d: number) => nextCardLabel(buildItems([card('ln00001')], { ln00001: reviewed(at(d)) }), [], now);
		expect(label(1)).toBe('Next card tomorrow');
		expect(label(3)).toBe('Next card in 3 days');
		expect(nextCardLabel([], [], now)).toBeNull();
	});
	it('new cards held back by the daily cap come back tomorrow', () => {
		const log = Array.from({ length: 10 }, (_, i) => entry(`lx${i}`, true));
		expect(nextCardLabel(buildItems([card('ln00002')], {}), log, now)).toBe('Next card tomorrow');
	});
});

describe('scheduler', () => {
	it('labels intervals compactly', () => {
		expect(formatInterval(10 * 60000)).toBe('10m');
		expect(formatInterval(3 * 3600000)).toBe('3h');
		expect(formatInterval(4 * 86400000)).toBe('4d');
		expect(formatInterval(60 * 86400000)).toBe('2mo');
		expect(formatInterval(400 * 86400000)).toBe('1y');
	});
	it('previews four grades in growing order and stores dates as ISO', () => {
		const p = sched.preview(freshCard(now), now);
		expect(Object.keys(p)).toEqual(['1', '2', '3', '4']);
		expect(p[4].card.due.getTime()).toBeGreaterThan(p[1].card.due.getTime());
		expect(fromStored(toStored(p[3].card)).due).toEqual(p[3].card.due);
	});
});
