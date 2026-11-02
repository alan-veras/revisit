import { Card as FsrsCard, createEmptyCard, fsrs, FSRS, Rating, State } from 'ts-fsrs';

export type Nota = 1 | 2 | 3 | 4;
export const NOTAS: { nota: Nota; nome: string }[] = [
	{ nota: 1, nome: 'Errei' },
	{ nota: 2, nome: 'Difícil' },
	{ nota: 3, nome: 'Bom' },
	{ nota: 4, nome: 'Fácil' },
];

/** FSRS card as stored in estado.json (dates as ISO strings). */
export type StoredFsrs = Omit<FsrsCard, 'due' | 'last_review' | 'state'> & { due: string; last_review?: string; state: number };

export function toStored(card: FsrsCard): StoredFsrs {
	const { due, last_review, state, ...rest } = card;
	return { ...rest, state, due: due.toISOString(), ...(last_review ? { last_review: last_review.toISOString() } : {}) };
}

export function fromStored(s: StoredFsrs): FsrsCard {
	const { due, last_review, state, ...rest } = s;
	return { ...rest, state, due: new Date(due), ...(last_review ? { last_review: new Date(last_review) } : {}) };
}

export function freshCard(now: Date): FsrsCard {
	return createEmptyCard(now);
}

export function isNew(card: FsrsCard | undefined): boolean {
	return !card || card.state === State.New;
}

/** "10 min", "3 h", "amanhã", "5 dias", "2 meses", "1 ano". */
export function formatInterval(ms: number): string {
	const min = Math.max(1, Math.round(ms / 60000));
	if (min < 60) return `${min} min`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h`;
	const d = Math.round(h / 24);
	if (d === 1) return 'amanhã';
	if (d < 31) return `${d} dias`;
	const m = Math.round(d / 30);
	if (m < 12) return m === 1 ? '1 mês' : `${m} meses`;
	const y = Math.round(d / 365);
	return y === 1 ? '1 ano' : `${y} anos`;
}

export class Scheduler {
	private f: FSRS;
	constructor(retention: number) {
		this.f = fsrs({ request_retention: retention, enable_fuzz: true });
	}

	/** The next card for each grade, plus a label for the buttons. */
	preview(card: FsrsCard, now: Date): Record<Nota, { card: FsrsCard; label: string }> {
		const p = this.f.repeat(card, now);
		const out = {} as Record<Nota, { card: FsrsCard; label: string }>;
		for (const { nota } of NOTAS) {
			const next = p[nota].card;
			out[nota] = { card: next, label: formatInterval(next.due.getTime() - now.getTime()) };
		}
		return out;
	}

	apply(card: FsrsCard, nota: Nota, now: Date): FsrsCard {
		return this.f.next(card, now, nota).card;
	}

	retrievability(card: FsrsCard, now: Date): number {
		if (card.state === State.New) return 0;
		return this.f.get_retrievability(card, now, false);
	}
}

export { Rating, State };
