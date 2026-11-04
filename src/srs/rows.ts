import { State } from 'ts-fsrs';
import { Tipo } from '../cards/types';
import { QueueItem } from './queue';

export type EstadoCartao = 'novo' | 'aprendendo' | 'revisao' | 'suspenso';

/** Estado shown for one card side: suspension wins, then the FSRS state. */
export function estadoOf(it: Pick<QueueItem, 'suspended' | 'fsrs'>): EstadoCartao {
	if (it.suspended) return 'suspenso';
	if (!it.fsrs || it.fsrs.state === State.New) return 'novo';
	return it.fsrs.state === State.Review ? 'revisao' : 'aprendendo';
}

export interface CardRow {
	key: string;
	/** base id of the card (reverse and cloze keys share it) */
	id: string;
	lado: string;
	frente: string;
	tipo: Tipo;
	area: string | null;
	assuntos: string[];
	estado: EstadoCartao;
	/** next due, null while the card is new */
	proxima: Date | null;
	/** due today or overdue */
	venceHoje: boolean;
	ok: number;
	bad: number;
	item: QueueItem;
}

/** One row per card side, what the browser and the CLI both show. */
export function cardRow(it: QueueItem, stats: Map<string, { ok: number; bad: number }>, now: Date): CardRow {
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);
	const proxima = it.fsrs && it.fsrs.state !== State.New ? it.fsrs.due : null;
	const s = it.card.id ? stats.get(it.card.id) : undefined;
	return {
		key: it.key,
		id: it.card.id as string,
		lado: it.reverso ? 'reverso' : it.cloze !== undefined ? `lacuna ${it.cloze + 1}` : 'frente',
		frente: it.card.frente,
		tipo: it.card.tipo,
		area: it.area,
		assuntos: it.card.assuntos,
		estado: estadoOf(it),
		proxima,
		venceHoje: !!proxima && proxima.getTime() <= end.getTime(),
		ok: s?.ok ?? 0,
		bad: s?.bad ?? 0,
		item: it,
	};
}

/** Browser order: due or overdue first (oldest on top), then new, then the future. */
export function rowOrder(a: CardRow, b: CardRow): number {
	const rank = (r: CardRow): number => (!r.proxima ? 1 : r.venceHoje ? 0 : 2);
	const d = rank(a) - rank(b);
	if (d !== 0) return d;
	if (a.proxima && b.proxima) return a.proxima.getTime() - b.proxima.getTime();
	return a.frente.localeCompare(b.frente, 'pt-BR');
}
