import { State } from 'ts-fsrs';
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

/** New cards introduced today, by area (ids without a known area are left out). */
export function newTodayByArea(log: RevlogEntry[], now: Date, areaOf: (id: string) => string | null): Map<string, number> {
	const day = now.toDateString();
	const seen = new Set<string>();
	const out = new Map<string, number>();
	for (const e of log) {
		if (!e.novo || e.extra || new Date(e.t).toDateString() !== day || seen.has(e.id)) continue;
		seen.add(e.id);
		const area = areaOf(e.id);
		if (area) out.set(area, (out.get(area) ?? 0) + 1);
	}
	return out;
}

/** `Área: n` per line; lines without a number are ignored, 0 is allowed. */
export function parseAreaQuota(text: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const line of text.split('\n')) {
		const m = /^(.+?):\s*(\d+)\s*$/.exec(line.trim());
		if (m) out[(m[1] as string).trim()] = Number(m[2]);
	}
	return out;
}

export interface QuotaLine {
	area: string;
	usados: number;
	teto: number;
	livres: number;
}

/** New cards per day of an area with no number of its own. */
export const DEFAULT_AREA_CAP = 5;

export interface QuotaStatus {
	/** the sum of the areas, for display; there is no general cap */
	total: { usados: number; teto: number; livres: number };
	/** each area: `cota` is the setting, `teto` the cota after the time budget */
	areas: (QuotaLine & { cota: number })[];
	/** due reviews fill the budget, so every cota shrank today */
	reduced: boolean;
}

/**
 * Share of the new-card cap that fits today: all of it while the reviews already
 * due use up to 80% of the budget, none once they pass it, a straight line between.
 */
export function budgetFactor(dueMinutes: number, budgetMinutes: number): number {
	if (budgetMinutes <= 0) return 0;
	const used = dueMinutes / budgetMinutes;
	if (used <= 0.8) return 1;
	if (used >= 1) return 0;
	return (1 - used) / 0.2;
}

/** How many new cards of a cap fit today, after the time budget. */
export function newAllowedToday(dueMinutes: number, budgetMinutes: number, cap: number): number {
	const f = budgetFactor(dueMinutes, budgetMinutes);
	return f === 1 ? cap : Math.floor(cap * f);
}

/** One answer for the session, the panel and the CLI: the new cards left today in each area. */
export function quotaStatus(o: { dueMinutes: number; budgetMinutes: number; areas: readonly string[]; perArea: Record<string, number>; usedByArea: Map<string, number> }): QuotaStatus {
	const f = budgetFactor(o.dueMinutes, o.budgetMinutes);
	const areas = o.areas.map((area) => {
		const cota = o.perArea[area] ?? DEFAULT_AREA_CAP;
		const teto = f === 1 ? cota : Math.floor(cota * f);
		const usados = o.usedByArea.get(area) ?? 0;
		return { area, cota, teto, usados, livres: Math.max(0, teto - usados) };
	});
	const sum = (k: 'usados' | 'teto' | 'livres') => areas.reduce((s, a) => s + a[k], 0);
	return { total: { usados: sum('usados'), teto: sum('teto'), livres: sum('livres') }, areas, reduced: f < 1 };
}

/**
 * Minutes of review per day, from today on: what is overdue counts today, then
 * each card on the day it falls due. New and pending cards are left out.
 */
export function forecast(
	items: { card: { tipo: Tipo; pendente?: boolean }; fsrs?: { due: Date; state: State }; suspended: boolean }[],
	secs: Record<Tipo, number>,
	now: Date,
	days = 7,
): number[] {
	const out = new Array<number>(days).fill(0);
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	for (const it of items) {
		if (it.suspended || it.card.pendente || !it.fsrs || it.fsrs.state === State.New) continue;
		const d = Math.max(0, Math.floor((it.fsrs.due.getTime() - start.getTime()) / 86400000));
		if (d < days) out[d] = (out[d] ?? 0) + secs[it.card.tipo];
	}
	return out.map((s) => Math.round(s / 6) / 10);
}
