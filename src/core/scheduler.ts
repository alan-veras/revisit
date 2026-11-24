import { Card as FsrsCard, createEmptyCard, fsrs, FSRS, State } from 'ts-fsrs';
import { Grade, GRADES, StoredFsrs } from './types';

export { State };

export function toStored(card: FsrsCard): StoredFsrs {
	const { due, last_review, state, ...rest } = card;
	return { ...rest, state, due: due.toISOString(), ...(last_review ? { last_review: last_review.toISOString() } : {}) };
}

export function fromStored(s: StoredFsrs): FsrsCard {
	const { due, last_review, state, ...rest } = s;
	return { ...rest, state, due: new Date(due), ...(last_review ? { last_review: new Date(last_review) } : {}) };
}

export const freshCard = (now: Date): FsrsCard => createEmptyCard(now);

export function isNew(card: FsrsCard | undefined): boolean {
	return !card || card.state === State.New;
}

/** Button label: "10m", "3h", "4d", "2mo", "1y". */
export function formatInterval(ms: number): string {
	const min = Math.max(1, Math.round(ms / 60000));
	if (min < 60) return `${min}m`;
	const h = Math.round(min / 60);
	if (h < 24) return `${h}h`;
	const d = Math.round(h / 24);
	if (d < 31) return `${d}d`;
	const m = Math.round(d / 30);
	if (m < 12) return `${m}mo`;
	return `${Math.round(d / 365)}y`;
}

export class Scheduler {
	private f: FSRS;
	constructor(retention: number) {
		this.f = fsrs({ request_retention: retention, enable_fuzz: true });
	}

	/** The next card and the button label for each grade. */
	preview(card: FsrsCard, now: Date): Record<Grade, { card: FsrsCard; label: string }> {
		const p = this.f.repeat(card, now);
		const out = {} as Record<Grade, { card: FsrsCard; label: string }>;
		for (const { grade } of GRADES) {
			const next = p[grade].card;
			out[grade] = { card: next, label: formatInterval(next.due.getTime() - now.getTime()) };
		}
		return out;
	}

	retrievability(card: FsrsCard, now: Date): number {
		return card.state === State.New ? 0 : this.f.get_retrievability(card, now, false);
	}
}
