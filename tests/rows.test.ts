import { describe, expect, it } from 'vitest';
import { State } from 'ts-fsrs';
import { Card } from '../src/cards/types';
import { QueueItem } from '../src/srs/queue';
import { cardRow, estadoOf, rowOrder } from '../src/srs/rows';
import { freshCard } from '../src/srs/scheduler';

const NOW = new Date('2026-11-04T10:00:00');

function item(over: { id: string; reverso?: boolean; cloze?: number; suspended?: boolean; fsrs?: QueueItem['fsrs'] }): QueueItem {
	const card: Card = { id: over.id, tipo: 'Pergunta', frente: `frente ${over.id}`, verso: over.id, assuntos: [], fonte: '', start: 0, end: 0 };
	return {
		key: over.id,
		reverso: over.reverso ?? false,
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

describe('estadoOf', () => {
	it('novo sem fsrs, suspenso ganha de tudo, aprendendo e revisão pelo FSRS', () => {
		expect(estadoOf(item({ id: 'x' }))).toBe('novo');
		expect(estadoOf({ ...reviewed('x', NOW), suspended: true })).toBe('suspenso');
		expect(estadoOf(reviewed('x', NOW, State.Learning))).toBe('aprendendo');
		expect(estadoOf(reviewed('x', NOW, State.Review))).toBe('revisao');
	});
});

describe('cardRow', () => {
	it('monta a linha com lado, estado, volta e placar', () => {
		const r = cardRow(reviewed('a', new Date('2026-11-04T09:00:00')), STATS, NOW);
		expect(r.id).toBe('a');
		expect(r.lado).toBe('frente');
		expect(r.estado).toBe('revisao');
		expect(r.proxima?.toISOString()).toBe('2026-11-04T12:00:00.000Z');
		expect(r.venceHoje).toBe(true);
		expect(r.ok).toBe(12);
		expect(r.bad).toBe(1);
	});
	it('cartão novo fica sem próxima, fora do venceHoje; lado marca reverso e lacuna', () => {
		const novo = cardRow(item({ id: 'n' }), STATS, NOW);
		expect(novo.estado).toBe('novo');
		expect(novo.proxima).toBeNull();
		expect(novo.venceHoje).toBe(false);
		expect(cardRow(item({ id: 'n', reverso: true }), STATS, NOW).lado).toBe('reverso');
		expect(cardRow(item({ id: 'n', cloze: 1 }), STATS, NOW).lado).toBe('lacuna 2');
	});
	it('due de amanhã não vence hoje', () => {
		expect(cardRow(reviewed('a', new Date('2026-11-05T08:00:00')), STATS, NOW).venceHoje).toBe(false);
	});
});

describe('rowOrder', () => {
	it('vencidas primeiro (mais velhas em cima), depois novos, depois futuro', () => {
		const velha = reviewed('velha', new Date('2026-11-01T08:00:00'));
		const hoje = reviewed('hoje', new Date('2026-11-04T09:00:00'));
		const novo = item({ id: 'novo' });
		const futuro = reviewed('futuro', new Date('2026-11-20T08:00:00'));
		const rows = [futuro, novo, hoje, velha].map((it) => cardRow(it, STATS, NOW));
		expect([...rows].sort(rowOrder).map((r) => r.id)).toEqual(['velha', 'hoje', 'novo', 'futuro']);
	});
});
