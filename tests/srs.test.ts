import { describe, expect, it } from 'vitest';
import { Card } from '../src/cards/types';
import { DEFAULT_SECS, newAllowedToday, newTodayByArea, quotaStatus, RevlogEntry, secsPerType } from '../src/srs/budget';
import { buildSession, burySiblings, interleave, matchesFilter, QueueItem, requeueIndex, sessionRequeue } from '../src/srs/queue';
import { formatInterval, freshCard, fromStored, Scheduler, toStored } from '../src/srs/scheduler';

const NOW = new Date('2026-11-02T10:00:00');
const sch = new Scheduler(0.9);

function card(id: string, topics: string[] = [], type: Card['type'] = 'Pergunta'): Card {
	return { id, type, front: id, back: id, topics, source: '', start: 0, end: 0 };
}

/** a card last reviewed `lastAgo` days ago, due `daysAgo` days ago (negative: in the future) */
function reviewed(id: string, daysAgo: number, topics: string[] = [], area = 'Carreira', lastAgo = 10): QueueItem {
	const at = (d: number) => new Date(NOW.getTime() - d * 86400000);
	let f = freshCard(at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo));
	f = { ...f, due: at(daysAgo) };
	return { key: id, reverse: false, card: card(id, topics), area, fsrs: f, suspended: false };
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

describe('importante na fila', () => {
	const tagged = (it: QueueItem): QueueItem => ({ ...it, card: { ...it.card, tags: ['importante'] } });
	const fresh = (id: string): QueueItem => ({ key: id, reverse: false, card: card(id), area: 'Carreira', suspended: false });
	it('importantes entram primeiro entre os novos quando a quota aperta', () => {
		const items = [fresh('a'), fresh('b'), tagged(fresh('c'))];
		expect(buildSession(items, opts({ newAllowed: 1 })).map((i) => i.card.id)).toEqual(['c']);
	});
	it('importantes não furam vencidos', () => {
		const items = [tagged(fresh('c')), reviewed('old', 3)];
		expect(buildSession(items, opts()).map((i) => i.card.id)).toEqual(['old', 'c']);
	});
});

describe('buildSession', () => {
	it('puts the most at-risk reviews first, then new cards', () => {
		const items = [reviewed('recent', 0, [], 'Carreira', 5), reviewed('old', 0, [], 'Carreira', 60), { key: 'new', reverse: false, card: card('new'), area: 'Carreira', suspended: false }];
		expect(buildSession(items, opts()).map((i) => i.card.id)).toEqual(['old', 'recent', 'new']);
	});
	it('limits new cards and skips suspended and future ones', () => {
		const fresh = ['a', 'b', 'c'].map((id) => ({ key: id, reverse: false, card: card(id), area: 'Carreira', suspended: false }));
		const future = reviewed('future', -5);
		const susp = { ...reviewed('susp', 3), suspended: true };
		expect(buildSession([...fresh, future, susp], opts({ newAllowed: 2 })).map((i) => i.card.id)).toEqual(['a', 'b']);
	});
	it('cuts at the time budget using seconds per type', () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ key: `q${i}`, reverse: false, card: card(`q${i}`, [], 'Questão'), area: 'Carreira', suspended: false }));
		expect(buildSession(items, opts({ budgetMinutes: 3 }))).toHaveLength(3);
	});
	it('filters by area and by topic prefix', () => {
		const a = reviewed('ti', 1, ['Concursos > TI'], 'Desenvolvimento Pessoal');
		const b = reviewed('k8s', 1, ['Kubernetes'], 'Carreira');
		expect(matchesFilter(a, 'Desenvolvimento Pessoal', 'Concursos')).toBe(true);
		expect(matchesFilter(a, null, 'Concurso')).toBe(false);
		expect(buildSession([a, b], opts({ area: 'Carreira' })).map((i) => i.card.id)).toEqual(['k8s']);
	});
	it('interleaves by first topic', () => {
		const xs = [reviewed('a1', 1, ['A']), reviewed('a2', 1, ['A']), reviewed('b1', 1, ['B'])];
		expect(interleave(xs).map((i) => i.card.id)).toEqual(['a1', 'b1', 'a2']);
	});
});

describe('fase 2', () => {
	const twin = (id: string): QueueItem[] => [
		{ key: id, reverse: false, card: card(id), area: 'Carreira', suspended: false },
		{ key: `${id}-r`, reverse: true, card: card(id), area: 'Carreira', suspended: false },
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
	const entry = (over: Partial<RevlogEntry>): RevlogEntry => ({ id: 'x', t: NOW.toISOString(), grade: 3, seconds: 20, type: 'Pergunta', new: false, extra: false, ...over });
	it('uses the median seconds after 5 grades, defaults before', () => {
		expect(secsPerType([entry({})]).Pergunta).toBe(10);
		const log = [8, 9, 30, 12, 11].map((s) => entry({ seconds: s }));
		expect(secsPerType(log).Pergunta).toBe(11);
	});
	it('reduces new cards as due reviews fill the budget', () => {
		expect(newAllowedToday(10, 20, 15)).toBe(15);
		expect(newAllowedToday(18, 20, 15)).toBe(7);
		expect(newAllowedToday(25, 20, 15)).toBe(0);
	});
});

describe('quota por área', () => {
	const newCard = (id: string, area: string): QueueItem => ({ key: id, reverse: false, card: card(id), area, suspended: false });
	const entry = (id: string, over: Partial<RevlogEntry> = {}): RevlogEntry => ({ id, t: NOW.toISOString(), grade: 3, seconds: 10, type: 'Pergunta', new: true, extra: false, ...over });
	it('newTodayByArea conta cada id new uma vez, por área, sem extra', () => {
		const area = (id: string) => (id.startsWith('e') ? 'Espiritual' : id.startsWith('d') ? 'Desenvolvimento Pessoal' : null);
		const log = [entry('e1'), entry('e1'), entry('e2'), entry('d1'), entry('d2', { extra: true }), entry('e3', { t: '2026-11-01T10:00:00' }), entry('x1')];
		const m = newTodayByArea(log, NOW, area);
		expect(m.get('Espiritual')).toBe(2);
		expect(m.get('Desenvolvimento Pessoal')).toBe(1);
	});
	it('a área para na quota dela enquanto as outras seguem; o geral ainda corta', () => {
		const items = [...['e1', 'e2', 'e3', 'e4', 'e5'].map((id) => newCard(id, 'Espiritual')), ...['d1', 'd2', 'd3', 'd4'].map((id) => newCard(id, 'Desenvolvimento Pessoal')), newCard('l1', 'Lazer')];
		const left = new Map([['Espiritual', 3], ['Desenvolvimento Pessoal', 10]]);
		const keys = buildSession(items, opts({ newLeftByArea: left })).map((i) => i.key);
		expect(keys.filter((k) => k.startsWith('e'))).toHaveLength(3);
		expect(keys.filter((k) => k.startsWith('d'))).toHaveLength(4);
		expect(keys).toContain('l1');
		expect(buildSession(items, opts({ newLeftByArea: left, newAllowed: 2 }))).toHaveLength(2);
		expect(buildSession(items, opts({ newLeftByArea: new Map([['Espiritual', 0]]) })).some((i) => i.area === 'Espiritual')).toBe(false);
	});
	it('quotaStatus dá 5 por padrão a cada área, encolhe com o orçamento e soma o total', () => {
		const q = quotaStatus({ dueMinutes: 0, budgetMinutes: 20, areas: ['Espiritual', 'Carreira', 'Lazer'], perArea: { Espiritual: 3, Lazer: 0 }, usedByArea: new Map([['Espiritual', 3], ['Carreira', 1]]) });
		expect(q.areas).toEqual([
			{ area: 'Espiritual', quota: 3, cap: 3, used: 3, free: 0 },
			{ area: 'Carreira', quota: 5, cap: 5, used: 1, free: 4 },
			{ area: 'Lazer', quota: 0, cap: 0, used: 0, free: 0 },
		]);
		expect(q.total).toEqual({ used: 4, cap: 8, free: 4 });
		expect(q.reduced).toBe(false);
		const r = quotaStatus({ dueMinutes: 18, budgetMinutes: 20, areas: ['Carreira'], perArea: {}, usedByArea: new Map() });
		expect(r.areas[0]).toMatchObject({ quota: 5, cap: 2 });
		expect(r.reduced).toBe(true);
	});
	it('cards without an area share the No area quota', () => {
		const sem = (id: string): QueueItem => ({ key: id, reverse: false, card: card(id), area: null, suspended: false });
		const keys = buildSession([sem('a'), sem('b'), sem('c')], opts({ newLeftByArea: new Map([['No area', 2]]) }));
		expect(keys).toHaveLength(2);
	});

});
