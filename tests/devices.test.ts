import { describe, expect, it } from 'vitest';
import { buildItems, buildQueue } from '../src/core/queue';
import { freshCard, Scheduler, toStored } from '../src/core/scheduler';
import { CardState, RevlogEntry } from '../src/core/types';
import { deckPath } from '../src/core/format';
import { isConflictPath, mergeLogs, mergeStates, newDeviceId } from '../src/store/data';

const now = new Date(2026, 10, 24, 12, 0, 0);
const st = (last: string | undefined, extra: Partial<CardState> = {}): CardState => ({
	st: 'active',
	fsrs: { ...toStored(freshCard(now)), ...(last ? { last_review: last } : {}) },
	...extra,
});
const e = (id: string, t: string, isNew = false): RevlogEntry => ({ id, t, grade: 3, seconds: 5, type: 'Question', new: isNew, extra: false });

describe('devices', () => {
	it('merges state by latest last_review, no last_review loses', () => {
		const legacy = { a: st('2026-11-01T10:00:00.000Z'), b: st(undefined), c: st('2026-11-03T10:00:00.000Z') };
		const dev = { a: st('2026-11-05T10:00:00.000Z'), b: st('2026-11-02T10:00:00.000Z'), c: st('2026-11-01T10:00:00.000Z') };
		const m = mergeStates([legacy, dev]);
		expect(m.a).toBe(dev.a);
		expect(m.b).toBe(dev.b);
		expect(m.c).toBe(legacy.c);
	});
	it('takes suspended/active from the winning entry', () => {
		const m = mergeStates([{ a: st('2026-11-01T10:00:00.000Z', { st: 'suspended' }) }, { a: st('2026-11-02T10:00:00.000Z') }]);
		expect(m.a?.st).toBe('active');
		const n = mergeStates([{ a: st('2026-11-03T10:00:00.000Z', { st: 'suspended' }) }, { a: st('2026-11-02T10:00:00.000Z') }]);
		expect(n.a?.st).toBe('suspended');
	});
	it('joins logs and orders them by time', () => {
		const out = mergeLogs([[e('a', '2026-11-02T10:00:00Z'), e('c', '2026-11-04T10:00:00Z')], [e('b', '2026-11-03T10:00:00Z')]]);
		expect(out.map((x) => x.id)).toEqual(['a', 'b', 'c']);
	});
	it('counts new cards of two devices against the daily cap', () => {
		const cards = Array.from({ length: 15 }, (_, i) => ({ id: `lnew${String(i).padStart(3, '0')}`, type: 'Question', front: 'q', back: 'a', topics: [], source: '', start: 0, end: 0 }));
		const t = now.toISOString();
		const log = mergeLogs([[e('x1', t, true), e('x2', t, true), e('x3', t, true)], [e('y1', t, true), e('y2', t, true)]]);
		const sched = new Scheduler(0.9);
		const q = buildQueue(buildItems(cards, {}), { now, log, retrievability: (c, n) => sched.retrievability(c, n) });
		expect(q).toHaveLength(5);
	});
	it('detects Syncthing conflict files', () => {
		expect(isConflictPath('R/devices/ab/state.sync-conflict-20260101-120000-ABC.json')).toBe(true);
		expect(isConflictPath('R/Deck.sync-conflict-20260101-120000-ABC.md')).toBe(true);
		expect(isConflictPath('R/Deck.md')).toBe(false);
	});
	it('makes short readable device ids', () => {
		expect(newDeviceId()).toMatch(/^[a-z2-9]{6}$/);
	});
});

describe('robustness', () => {
	it('keeps a log line with a bad time from scrambling the order', () => {
		const out = mergeLogs([[e('a', '2026-11-02T10:00:00Z'), e('bad', 'x'), e('c', '2026-11-04T10:00:00Z')], [e('b', '2026-11-03T10:00:00Z')]]);
		expect(out.filter((x) => x.id !== 'bad').map((x) => x.id)).toEqual(['a', 'b', 'c']);
	});
	it('never puts a deck inside the devices folder', () => {
		expect(deckPath(['devices > x'], 'R').startsWith('R/devices/')).toBe(false);
		expect(deckPath(['Devices'], 'R')).not.toBe('R/devices/.md');
	});
});
