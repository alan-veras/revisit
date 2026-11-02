/**
 * Rereading whole notes: each note marked to reread comes back after some days.
 * The interval grows with each reading (Difícil x1.2, Bom x2.5, Fácil x4),
 * between 1 and 365 days. No FSRS here: a note is not a question.
 */

export type Leitura = 'dificil' | 'bom' | 'facil';

export interface Releitura {
	/** ISO date of the next reading */
	due: string;
	/** days of the last interval */
	dias: number;
	/** ISO time of the last reading */
	lida: string;
	/** how many times it was read */
	vezes: number;
}

const FIRST: Record<Leitura, number> = { dificil: 1, bom: 3, facil: 7 };
const GROW: Record<Leitura, number> = { dificil: 1.2, bom: 2.5, facil: 4 };

export function nextInterval(prev: Releitura | undefined, l: Leitura): number {
	const d = prev ? Math.round(prev.dias * GROW[l]) : FIRST[l];
	return Math.min(365, Math.max(1, d));
}

export function read(prev: Releitura | undefined, l: Leitura, now: Date): Releitura {
	const dias = nextInterval(prev, l);
	const due = new Date(now);
	due.setHours(0, 0, 0, 0);
	due.setDate(due.getDate() + dias);
	return { due: due.toISOString(), dias, lida: now.toISOString(), vezes: (prev?.vezes ?? 0) + 1 };
}

export function daysLabel(d: number): string {
	if (d < 30) return d === 1 ? '1 dia' : `${d} dias`;
	const m = Math.round(d / 30);
	return m < 12 ? (m === 1 ? '1 mês' : `${m} meses`) : '1 ano';
}

/**
 * Notes to reread today: the due ones (oldest first), then never-read ones,
 * at most `newCap` of those per day.
 */
export function dueNotes(notes: { path: string; r?: Releitura }[], now: Date, newCap: number): string[] {
	const day = now.toDateString();
	const startedToday = notes.filter((n) => n.r?.vezes === 1 && new Date(n.r.lida).toDateString() === day).length;
	const due = notes
		.filter((n) => n.r && new Date(n.r.due) <= now)
		.sort((a, b) => (a.r as Releitura).due.localeCompare((b.r as Releitura).due))
		.map((n) => n.path);
	const fresh = notes
		.filter((n) => !n.r)
		.slice(0, Math.max(0, newCap - startedToday))
		.map((n) => n.path);
	return due.concat(fresh);
}
