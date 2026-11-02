import { Tipo } from '../cards/types';

export interface RevlogEntry {
	id: string;
	/** ISO time of the grade */
	t: string;
	nota: number;
	/** seconds from showing the front to grading */
	segundos: number;
	tipo: Tipo;
	/** the card was new before this grade */
	novo: boolean;
	extra: boolean;
}

export const DEFAULT_SECS: Record<Tipo, number> = { Pergunta: 10, Lacuna: 10, 'Referência': 10, 'Questão': 60 };

/** Median seconds per card type over the last 200 grades of that type. */
export function secsPerType(log: RevlogEntry[]): Record<Tipo, number> {
	const out = { ...DEFAULT_SECS };
	for (const tipo of Object.keys(out) as Tipo[]) {
		const xs = log
			.filter((e) => e.tipo === tipo && e.segundos > 0)
			.slice(-200)
			.map((e) => Math.min(300, Math.max(3, e.segundos)))
			.sort((a, b) => a - b);
		if (xs.length >= 5) out[tipo] = xs[Math.floor(xs.length / 2)] as number;
	}
	return out;
}

/** New cards already introduced today (local day). */
export function newToday(log: RevlogEntry[], now: Date): number {
	const day = now.toDateString();
	const seen = new Set<string>();
	for (const e of log) if (e.novo && !e.extra && new Date(e.t).toDateString() === day) seen.add(e.id);
	return seen.size;
}

/**
 * How many new cards fit today: the cap while the reviews already due use up to
 * 80% of the budget, nothing once they pass it, and a straight line between.
 */
export function newAllowedToday(dueMinutes: number, budgetMinutes: number, cap: number): number {
	if (budgetMinutes <= 0) return 0;
	const used = dueMinutes / budgetMinutes;
	if (used <= 0.8) return cap;
	if (used >= 1) return 0;
	return Math.floor(cap * ((1 - used) / 0.2));
}
