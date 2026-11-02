import { describe, expect, it } from 'vitest';
import { Card } from '../src/cards/types';
import { DEFAULT_SECS, newAllowedToday, newToday, RevlogEntry, secsPerType } from '../src/srs/budget';
import { buildSession, buryGemeos, interleave, matchesFilter, QueueItem, requeueIndex } from '../src/srs/queue';
import { formatInterval, freshCard, fromStored, Scheduler, toStored } from '../src/srs/scheduler';

const NOW = new Date('2026-11-02T10:00:00');
const sch = new Scheduler(0.9);

function card(id: string, assuntos: string[] = [], tipo: Card['tipo'] = 'Pergunta'): Card {
	return { id, tipo, frente: id, verso: id, assuntos, fonte: '', start: 0, end: 0 };
}

/** a card last reviewed `lastAgo` days ago, due `daysAgo` days ago (negative: in the future) */
function reviewed(id: string, daysAgo: number, assuntos: string[] = [], area = 'Carreira', lastAgo = 10): QueueItem {
	const at = (d: number) => new Date(NOW.getTime() - d * 86400000);
	let f = freshCard(at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo + 10));
	f = sch.apply(f, 3, at(lastAgo));
	f = { ...f, due: at(daysAgo) };
	return { key: id, reverso: false, card: card(id, assuntos), area, fsrs: f, suspended: false };
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
	it('formats intervals in Portuguese', () => {
		expect(formatInterval(10 * 60000)).toBe('10 min');
		expect(formatInterval(86400000)).toBe('amanhã');
		expect(formatInterval(5 * 86400000)).toBe('5 dias');
		expect(formatInterval(60 * 86400000)).toBe('2 meses');
	});
});

describe('buildSession', () => {
	it('puts the most at-risk reviews first, then new cards', () => {
		const items = [reviewed('recent', 0, [], 'Carreira', 5), reviewed('old', 0, [], 'Carreira', 60), { key: 'new', reverso: false, card: card('new'), area: 'Carreira', suspended: false }];
		expect(buildSession(items, opts()).map((i) => i.card.id)).toEqual(['old', 'recent', 'new']);
	});
	it('limits new cards and skips suspended and future ones', () => {
		const fresh = ['a', 'b', 'c'].map((id) => ({ key: id, reverso: false, card: card(id), area: 'Carreira', suspended: false }));
		const future = reviewed('future', -5);
		const susp = { ...reviewed('susp', 3), suspended: true };
		expect(buildSession([...fresh, future, susp], opts({ newAllowed: 2 })).map((i) => i.card.id)).toEqual(['a', 'b']);
	});
	it('cuts at the time budget using seconds per type', () => {
		const items = Array.from({ length: 10 }, (_, i) => ({ key: `q${i}`, reverso: false, card: card(`q${i}`, [], 'Questão'), area: 'Carreira', suspended: false }));
		expect(buildSession(items, opts({ budgetMinutes: 3 }))).toHaveLength(3);
	});
	it('filters by area and by assunto prefix', () => {
		const a = reviewed('ti', 1, ['Concursos > TI'], 'Desenvolvimento Pessoal');
		const b = reviewed('k8s', 1, ['Kubernetes'], 'Carreira');
		expect(matchesFilter(a, 'Desenvolvimento Pessoal', 'Concursos')).toBe(true);
		expect(matchesFilter(a, null, 'Concurso')).toBe(false);
		expect(buildSession([a, b], opts({ area: 'Carreira' })).map((i) => i.card.id)).toEqual(['k8s']);
	});
	it('interleaves by first assunto', () => {
		const xs = [reviewed('a1', 1, ['A']), reviewed('a2', 1, ['A']), reviewed('b1', 1, ['B'])];
		expect(interleave(xs).map((i) => i.card.id)).toEqual(['a1', 'b1', 'a2']);
	});
});

describe('fase 2', () => {
	const twin = (id: string): QueueItem[] => [
		{ key: id, reverso: false, card: card(id), area: 'Carreira', suspended: false },
		{ key: `${id}-r`, reverso: true, card: card(id), area: 'Carreira', suspended: false },
	];
	it('keeps a card and its reverse apart', () => {
		expect(buryGemeos(twin('a'), new Set()).map((i) => i.key)).toEqual(['a']);
		expect(buryGemeos(twin('a'), new Set(['a'])).map((i) => i.key)).toEqual(['a']);
		expect(buildSession(twin('a').concat(twin('b')), opts({ newAllowed: 1 })).map((i) => i.key)).toEqual(['a']);
	});
	it('brings back a card due within the session', () => {
		const q = Array.from({ length: 6 }, (_, i) => reviewed(`c${i}`, 1));
		expect(requeueIndex(q, 0, new Date(NOW.getTime() + 60000), NOW, DEFAULT_SECS)).toBe(4);
		expect(requeueIndex(q, 4, new Date(NOW.getTime() + 60000), NOW, DEFAULT_SECS)).toBe(6);
		expect(requeueIndex(q, 0, new Date(NOW.getTime() + 86400000), NOW, DEFAULT_SECS)).toBe(-1);
	});
	it('extra session takes everything', () => {
		const items = [reviewed('due', 1), reviewed('later', -20)];
		expect(buildSession(items, opts({ extra: true })).map((i) => i.key).sort()).toEqual(['due', 'later']);
		expect(buildSession(items, opts()).map((i) => i.key)).toEqual(['due']);
	});
});

describe('budget', () => {
	const entry = (over: Partial<RevlogEntry>): RevlogEntry => ({ id: 'x', t: NOW.toISOString(), nota: 3, segundos: 20, tipo: 'Pergunta', novo: false, extra: false, ...over });
	it('uses the median seconds after 5 grades, defaults before', () => {
		expect(secsPerType([entry({})]).Pergunta).toBe(10);
		const log = [8, 9, 30, 12, 11].map((s) => entry({ segundos: s }));
		expect(secsPerType(log).Pergunta).toBe(11);
	});
	it('counts new cards introduced today', () => {
		const log = [entry({ id: 'a', novo: true }), entry({ id: 'a', novo: true }), entry({ id: 'b', novo: true, t: '2026-11-01T10:00:00' }), entry({ id: 'c' })];
		expect(newToday(log, NOW)).toBe(1);
	});
	it('reduces new cards as due reviews fill the budget', () => {
		expect(newAllowedToday(10, 20, 15)).toBe(15);
		expect(newAllowedToday(18, 20, 15)).toBe(7);
		expect(newAllowedToday(25, 20, 15)).toBe(0);
	});
});
