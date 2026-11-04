import { Card as FsrsCard, createEmptyCard, fsrs, FSRS, Rating, State } from 'ts-fsrs';

export type Grade = 1 | 2 | 3 | 4;
export const GRADES: { grade: Grade; name: string }[] = [
	{ grade: 1, name: 'Errei' },
	{ grade: 2, name: 'Difícil' },
	{ grade: 3, name: 'Bom' },
	{ grade: 4, name: 'Fácil' },
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

/** "10 min", "3 h", "amanhã", "5 days", "2 meses", "1 ano". */
export function formatInterval(ms: number): string {
	const min = Math.max(1, Math.round(ms / 60000));
	if (min < 60) return `${min} min`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h} h`;
	const d = Math.round(h / 24);
	if (d === 1) return 'amanhã';
	if (d < 31) return `${d} days`;
	const m = Math.round(d / 30);
	if (m < 12) return m === 1 ? '1 mês' : `${m} meses`;
	const y = Math.round(d / 365);
	return y === 1 ? '1 ano' : `${y} anos`;
}

export class Scheduler {
	private f: FSRS;
	private fImportant: FSRS;
	constructor(retention: number, retentionImportant = retention) {
		this.f = fsrs({ request_retention: retention, enable_fuzz: true });
		this.fImportant = fsrs({ request_retention: retentionImportant, enable_fuzz: true });
	}

	private pick(important: boolean): FSRS {
		return important ? this.fImportant : this.f;
	}

	/** The next card for each grade, plus a label for the buttons. */
	preview(card: FsrsCard, now: Date, important = false): Record<Grade, { card: FsrsCard; label: string }> {
		const p = this.pick(important).repeat(card, now);
		const out = {} as Record<Grade, { card: FsrsCard; label: string }>;
		for (const { grade } of GRADES) {
			const next = p[grade].card;
			out[grade] = { card: next, label: formatInterval(next.due.getTime() - now.getTime()) };
		}
		return out;
	}

	apply(card: FsrsCard, grade: Grade, now: Date, important = false): FsrsCard {
		return this.pick(important).next(card, now, grade).card;
	}

	retrievability(card: FsrsCard, now: Date): number {
		if (card.state === State.New) return 0;
		return this.f.get_retrievability(card, now, false);
	}
}

export { Rating, State };
