import { describe, expect, it } from 'vitest';
import { Card } from '../src/cards/types';
import { DEFAULT_SECS, newAllowedToday, newToday, quotaStatus, RevlogEntry, secsPerType } from '../src/srs/budget';
import { buildSession, burySiblings, inScope, interleave, matchesFilter, QueueItem, requeueIndex, reviewScopes, sessionRequeue, sourceName } from '../src/srs/queue';
import { formatInterval, freshCard, fromStored, Scheduler, toStored } from '../src/srs/scheduler';

const NOW = new Date('2026-11-02T10:00:00');
const sch = new Scheduler(0.9);

function card(id: string, topics: string[] = [], type: Card['type'] = 'Question'): Card {
	return { id, type, front: id, back: id, topics, source: '', start: 0, end: 0 };
}

/** a card last reviewed `lastAgo` days ago, due `daysAgo` days ago (negative: in the future) */
function reviewed(id: string, daysAgo: number, topics: string[] = [], source: string | null = null, lastAgo = 10): QueueItem {
	const at = (d: number) => new Date(NOW.getTime() - d * 86400000);
	let f = freshCard(at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo));
	f = { ...f, due: at(daysAgo) };
	return { key: id, reverse: false, card: card(id, topics), source, fsrs: f, suspended: false };
}

const opts = (over: Partial<Parameters<typeof buildSession>[1]> = {}) => ({
	now: NOW,
	budgetMinutes: 20,
	newAllowed: 15,
	secs: DEFAULT_SECS,
	interleave: false,
	retrievability: (c: Parameters<Scheduler['retrievability']>[0], n: Date) => sch.retrievability(c, n),
	...over,
});

describe('scheduler', () => {
	it('intervals grow from Errei to Fácil, and Errei comes back soon', () => {
		const p = sch.preview(freshCard(NOW), NOW);
		const ms = ([1, 2, 3, 4] as const).map((n) => p[n].card.due.getTime() - NOW.getTime());
		expect(ms[0]).toBeLessThan(ms[1] as number);
		expect(ms[1]).toBeLessThanOrEqual(ms[2] as number);
		expect(ms[2]).toBeLessThan(ms[3] as number);
		expect(ms[0]).toBeLessThan(60 * 60000);
	});
	it('stores and restores a card', () => {
		const f = sch.apply(freshCard(NOW), 3, NOW);
		const back = fromStored(JSON.parse(JSON.stringify(toStored(f))) as ReturnType<typeof toStored>);
		expect(back.due.getTime()).toBe(f.due.getTime());
		expect(back.state).toBe(f.state);
		expect(back.stability).toBe(f.stability);
	});
	it('important cards get shorter intervals from the higher retention', () => {
		const both = new Scheduler(0.9, 0.97);
		let f = freshCard(NOW);
		f = both.apply(f, 3, NOW);
		f = both.apply(f, 3, new Date(NOW.getTime() + 86400000));
		const later = new Date(NOW.getTime() + 5 * 86400000);
		const normal = both.preview(f, later)[3].card.scheduled_days;
		const important = both.preview(f, later, true)[3].card.scheduled_days;
		expect(important).toBeLessThan(normal);
	});
	it('formats intervals', () => {
		expect(formatInterval(10 * 60000)).toBe('10 min');
		expect(formatInterval(86400000)).toBe('tomorrow');
		expect(formatInterval(5 * 86400000)).toBe('5 days');
		expect(formatInterval(60 * 86400000)).toBe('2 months');
	});
});

describe('important na fila', () => {
	const tagged = (it: QueueItem): QueueItem => ({ ...it, card: { ...it.card, tags: ['important'] } });
	const fresh = (id: string): QueueItem => ({ key: id, reverse: false, card: card(id), source: null, suspended: false });
	it('importants entram primeiro entre os novos quando a quota aperta', () => {
		const items = [fresh('a'), fresh('b'), tagged(fresh('c'))];
		expect(buildSession(items, opts({ newAllowed: 1 })).map((i) => i.card.id)).toEqual(['c']);
	});
	it('importants não furam vencidos', () => {
		const items = [tagged(fresh('c')), reviewed('old', 3)];
		expect(buildSession(items, opts()).map((i) => i.card.id)).toEqual(['old', 'c']);
	});
});

describe('buildSession', () => {
	it('puts the most at-risk reviews first, then new cards', () => {
		const items = [reviewed('recent', 0, [], null, 5), reviewed('old', 0, [], null, 60), { key: 'new', reverse: false, card: card('new'), source: null, suspended: false }];
		expect(buildSession(items, opts()).map((i) => i.card.id)).toEqual(['old', 'recent', 'new']);
	});
	it('limits new cards and skips suspended and future ones', () => {
		const fresh = ['a', 'b', 'c'].map((id) => ({ key: id, reverse: false, card: card(id), source: null, suspended: false }));
		const future = reviewed('future', -5);
		const susp = { ...reviewed('susp', 3), suspended: true };
		expect(buildSession([...fresh, future, susp], opts({ newAllowed: 2 })).map((i) => i.card.id)).toEqual(['a', 'b']);
	});
	it('cuts at the time budget using seconds per type', () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ key: `q${i}`, reverse: false, card: card(`q${i}`, [], 'Problem'), source: null, suspended: false }));
		expect(buildSession(items, opts({ budgetMinutes: 3 }))).toHaveLength(3);
	});
	it('filters by note, by folder and by topic prefix', () => {
		const a = reviewed('ti', 1, ['Exams > IT'], 'Study/Exams/IT.md');
		const b = reviewed('k8s', 1, ['Kubernetes'], 'Work/K8s.md');
		const c = reviewed('none', 1);
		expect(matchesFilter(a, 'Study', 'Exams')).toBe(true);
		expect(matchesFilter(a, null, 'Exam')).toBe(false);
		expect(matchesFilter(a, 'Stu')).toBe(false);
		expect(matchesFilter(c, 'No source')).toBe(true);
		expect(buildSession([a, b, c], opts({ scope: 'Work' })).map((i) => i.card.id)).toEqual(['k8s']);
		expect(buildSession([a, b, c], opts({ scope: 'Study/Exams/IT.md' })).map((i) => i.card.id)).toEqual(['ti']);
		expect(buildSession([a, b, c], opts({ scope: 'Study/Exams' })).map((i) => i.card.id)).toEqual(['ti']);
	});
	it('interleaves by first topic', () => {
		const xs = [reviewed('a1', 1, ['A']), reviewed('a2', 1, ['A']), reviewed('b1', 1, ['B'])];
		expect(interleave(xs).map((i) => i.card.id)).toEqual(['a1', 'b1', 'a2']);
	});
});

describe('fase 2', () => {
	const twin = (id: string): QueueItem[] => [
		{ key: id, reverse: false, card: card(id), source: null, suspended: false },
		{ key: `${id}-r`, reverse: true, card: card(id), source: null, suspended: false },
	];
	it('keeps a card and its reverse apart', () => {
		expect(burySiblings(twin('a'), new Set()).map((i) => i.key)).toEqual(['a']);
		expect(burySiblings(twin('a'), new Set(['a'])).map((i) => i.key)).toEqual(['a']);
		expect(buildSession(twin('a').concat(twin('b')), opts({ newAllowed: 1 })).map((i) => i.key)).toEqual(['a']);
	});
	it('brings back a card due within the session', () => {
		const q = Array.from({ length: 6 }, (_, i) => reviewed(`c${i}`, 1));
		expect(requeueIndex(q, 0, new Date(NOW.getTime() + 60000), NOW, DEFAULT_SECS)).toBe(4);
		expect(requeueIndex(q, 4, new Date(NOW.getTime() + 60000), NOW, DEFAULT_SECS)).toBe(6);
		expect(requeueIndex(q, 0, new Date(NOW.getTime() + 86400000), NOW, DEFAULT_SECS)).toBe(-1);
	});
	it('sessionRequeue traz o prazo curto de qualquer grade, e na extra só o Errei', () => {
		const q = Array.from({ length: 6 }, (_, i) => reviewed(`c${i}`, 1));
		const o = { queue: q, index: 0, now: NOW, secs: DEFAULT_SECS, gap: 3 };
		expect(sessionRequeue({ ...o, extra: false, grade: 3, due: new Date(NOW.getTime() + 600000) })).toBe(4);
		expect(sessionRequeue({ ...o, extra: false, grade: 2, due: new Date(NOW.getTime() + 360000) })).toBe(4);
		expect(sessionRequeue({ ...o, extra: false, grade: 3, due: new Date(NOW.getTime() + 3 * 86400000) })).toBe(-1);
		expect(sessionRequeue({ ...o, extra: true, grade: 1, due: new Date(NOW.getTime() + 86400000) })).toBe(4);
		expect(sessionRequeue({ ...o, extra: true, grade: 3, due: new Date(NOW.getTime() + 600000) })).toBe(-1);
	});
	it('extra session takes everything', () => {
		const items = [reviewed('due', 1), reviewed('later', -20)];
		expect(buildSession(items, opts({ extra: true })).map((i) => i.key).sort()).toEqual(['due', 'later']);
		expect(buildSession(items, opts()).map((i) => i.key)).toEqual(['due']);
	});
});

describe('budget', () => {
	const entry = (over: Partial<RevlogEntry>): RevlogEntry => ({ id: 'x', t: NOW.toISOString(), grade: 3, seconds: 20, type: 'Question', new: false, extra: false, ...over });
	it('uses the median seconds after 5 grades, defaults before', () => {
		expect(secsPerType([entry({})]).Question).toBe(10);
		const log = [8, 9, 30, 12, 11].map((s) => entry({ seconds: s }));
		expect(secsPerType(log).Question).toBe(11);
	});
	it('reduces new cards as due reviews fill the budget', () => {
		expect(newAllowedToday(10, 20, 15)).toBe(15);
		expect(newAllowedToday(18, 20, 15)).toBe(7);
		expect(newAllowedToday(25, 20, 15)).toBe(0);
	});
});

describe('daily quota', () => {
	const newCard = (id: string, source: string | null): QueueItem => ({ key: id, reverse: false, card: card(id), source, suspended: false });
	const entry = (id: string, over: Partial<RevlogEntry> = {}): RevlogEntry => ({ id, t: NOW.toISOString(), grade: 3, seconds: 10, type: 'Question', new: true, extra: false, ...over });
	it('newToday counts each new id once, without extra sessions or other days', () => {
		const log = [entry('a'), entry('a'), entry('b'), entry('c', { extra: true }), entry('d', { t: '2026-11-01T10:00:00' }), entry('e', { new: false })];
		expect(newToday(log, NOW)).toBe(2);
	});
	it('one cap across every folder', () => {
		const items = [newCard('a', 'A/x.md'), newCard('b', 'B/y.md'), newCard('c', 'C/z.md'), newCard('d', null)];
		expect(buildSession(items, opts({ newAllowed: 2 })).map((i) => i.key)).toEqual(['a', 'b']);
		expect(buildSession(items, opts({ newAllowed: 0 }))).toHaveLength(0);
	});
	it('quotaStatus subtracts what was used and shrinks with the budget', () => {
		expect(quotaStatus({ dueMinutes: 0, budgetMinutes: 20, quota: 20, used: 3 })).toEqual({ quota: 20, cap: 20, used: 3, free: 17, reduced: false });
		expect(quotaStatus({ dueMinutes: 18, budgetMinutes: 20, quota: 20, used: 3 })).toEqual({ quota: 20, cap: 9, used: 3, free: 6, reduced: true });
		expect(quotaStatus({ dueMinutes: 30, budgetMinutes: 20, quota: 20, used: 3 }).free).toBe(0);
	});
});

describe('review this note/folder', () => {
	const at = (source: string | null) => ({ source });
	it('offers the open note and its folders first, then the rest', () => {
		const items = [at('Bio/Sub/Dna.md'), at('Bio/Cells.md'), at('Art/Monet.md'), at(null)];
		expect(reviewScopes(items, 'Bio/Sub/Dna.md')).toEqual(['Bio/Sub/Dna.md', 'Bio/Sub', 'Bio', 'Art', 'Art/Monet.md', 'Bio/Cells.md', 'No source']);
	});
	it('without an open note, or one without cards, every source in order', () => {
		const items = [at('B/x.md'), at('A.md')];
		expect(reviewScopes(items, null)).toEqual(['A.md', 'B', 'B/x.md']);
		expect(reviewScopes(items, 'B/other.md')).toEqual(['B', 'A.md', 'B/x.md']);
	});
	it('a folder does not match a sibling that shares its prefix', () => {
		expect(inScope('Bio 2/x.md', 'Bio')).toBe(false);
		expect(inScope('Bio/x.md', 'Bio/')).toBe(true);
	});
	it('sourceName is short', () => {
		expect(sourceName(at('a/b/Cells.md'))).toBe('Cells');
		expect(sourceName(at('a/Exam.pdf'))).toBe('Exam.pdf');
		expect(sourceName(at(null))).toBe('No source');
	});
});
