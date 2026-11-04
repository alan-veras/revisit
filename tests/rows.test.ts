import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import { Card } from '../src/cards/types';
import { QueueItem } from '../src/srs/queue';
import { cardRow, statusOf, rowOrder } from '../src/srs/rows';
import { freshCard } from '../src/srs/scheduler';

const NOW = new Date('2026-11-04T10:00:00');

function item(over: { id: string; reverse?: boolean; cloze?: number; suspended?: boolean; fsrs?: QueueItem['fsrs'] }): QueueItem {
	const card: Card = { id: over.id, type: 'Pergunta', front: `front ${over.id}`, back: over.id, topics: [], source: '', start: 0, end: 0 };
	return {
		key: over.id,
		reverse: over.reverse ?? false,
		...(over.cloze !== undefined ? { cloze: over.cloze } : {}),
		card,
		area: 'Carreira',
		...(over.fsrs ? { fsrs: over.fsrs } : {}),
		suspended: over.suspended ?? false,
	};
}

/** card reviewed once in the past, with a due date set by hand */
function reviewed(id: string, due: Date, state: State = State.Review): QueueItem {
	const f = { ...freshCard(NOW), state, due };
	return item({ id, fsrs: f });
}

const STATS = new Map([
	['a', { ok: 12, bad: 1 }],
	['b', { ok: 0, bad: 3 }],
]);

describe('statusOf', () => {
	it('new sem fsrs, suspended ganha de tudo, learning e revisão pelo FSRS', () => {
		expect(statusOf(item({ id: 'x' }))).toBe('new');
		expect(statusOf({ ...reviewed('x', NOW), suspended: true })).toBe('suspended');
		expect(statusOf(reviewed('x', NOW, State.Learning))).toBe('learning');
		expect(statusOf(reviewed('x', NOW, State.Review))).toBe('review');
	});
});

describe('cardRow', () => {
	it('monta a linha com side, status, volta e placar', () => {
		const r = cardRow(reviewed('a', new Date('2026-11-04T09:00:00')), STATS, NOW);
		expect(r.id).toBe('a');
		expect(r.side).toBe('front');
		expect(r.status).toBe('review');
		expect(r.due?.toISOString()).toBe('2026-11-04T12:00:00.000Z');
		expect(r.dueToday).toBe(true);
		expect(r.ok).toBe(12);
		expect(r.bad).toBe(1);
	});
	it('cartão new fica sem próxima, fora do dueToday; side marca reverse e lacuna', () => {
		const newCard = cardRow(item({ id: 'n' }), STATS, NOW);
		expect(newCard.status).toBe('new');
		expect(newCard.due).toBeNull();
		expect(newCard.dueToday).toBe(false);
		expect(cardRow(item({ id: 'n', reverse: true }), STATS, NOW).side).toBe('reverse');
		expect(cardRow(item({ id: 'n', cloze: 1 }), STATS, NOW).side).toBe('lacuna 2');
	});
	it('due de amanhã não vence hoje', () => {
		expect(cardRow(reviewed('a', new Date('2026-11-05T08:00:00')), STATS, NOW).dueToday).toBe(false);
	});
});

describe('rowOrder', () => {
	it('vencidas primeiro (mais velhas em cima), depois novos, depois futuro', () => {
		const velha = reviewed('velha', new Date('2026-11-01T08:00:00'));
		const hoje = reviewed('hoje', new Date('2026-11-04T09:00:00'));
		const newCard = item({ id: 'new' });
		const futuro = reviewed('futuro', new Date('2026-11-20T08:00:00'));
		const rows = [futuro, newCard, hoje, velha].map((it) => cardRow(it, STATS, NOW));
		expect([...rows].sort(rowOrder).map((r) => r.id)).toEqual(['velha', 'hoje', 'new', 'futuro']);
	});
});
