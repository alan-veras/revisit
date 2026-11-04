/**
 * Rereading whole notes: each note marked to reread comes back after some days.
 * The interval grows with each reading (Hard x1.2, Good x2.5, Easy x4),
 * between 1 and 365 days. No FSRS here: a note is not a question.
 */

export type RereadGrade = 'hard' | 'good' | 'easy';

export interface Reread {
	/** ISO date of the next reading */
	due: string;
	/** days of the last interval */
	days: number;
	/** ISO time of the last reading */
	lastRead: string;
	/** how many times it was read */
	times: number;
}

const FIRST: Record<RereadGrade, number> = { hard: 1, good: 3, easy: 7 };
const GROW: Record<RereadGrade, number> = { hard: 1.2, good: 2.5, easy: 4 };

export function nextInterval(prev: Reread | undefined, l: RereadGrade): number {
	const d = prev ? Math.round(prev.days * GROW[l]) : FIRST[l];
	return Math.min(365, Math.max(1, d));
}

export function read(prev: Reread | undefined, l: RereadGrade, now: Date): Reread {
	const days = nextInterval(prev, l);
	const due = new Date(now);
	due.setHours(0, 0, 0, 0);
	due.setDate(due.getDate() + days);
	return { due: due.toISOString(), days, lastRead: now.toISOString(), times: (prev?.times ?? 0) + 1 };
}

export function daysLabel(d: number): string {
	if (d < 30) return d === 1 ? '1 day' : `${d} days`;
	const m = Math.round(d / 30);
	return m < 12 ? (m === 1 ? '1 month' : `${m} months`) : '1 year';
}

/** When a date falls, counted in calendar days from `now`: today, tomorrow, in 3 days, in 2 months. */
export function untilLabel(due: Date, now: Date): string {
	const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000;
	const d = Math.round(day(due) - day(now));
	if (d <= 0) return 'today';
	if (d === 1) return 'tomorrow';
	return `in ${daysLabel(d)}`;
}

/**
 * Notes to reread today: the due ones (oldest first), then never-read ones,
 * at most `newCap` of those per day.
 */
export function dueNotes(notes: { path: string; r?: Reread }[], now: Date, newCap: number): string[] {
	const day = now.toDateString();
	const startedToday = notes.filter((n) => n.r?.times === 1 && new Date(n.r.lastRead).toDateString() === day).length;
	const due = notes
		.filter((n) => n.r && new Date(n.r.due) <= now)
		.sort((a, b) => (a.r as Reread).due.localeCompare((b.r as Reread).due))
		.map((n) => n.path);
	const fresh = notes
		.filter((n) => !n.r)
		.slice(0, Math.max(0, newCap - startedToday))
		.map((n) => n.path);
	return due.concat(fresh);
}
