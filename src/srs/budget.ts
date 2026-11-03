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

export interface QuotaStatus {
	/** the general cap; `teto` already cut by the time budget, `cap` is the setting */
	geral: QuotaLine & { cap: number };
	areas: QuotaLine[];
}

/** One answer for the session, the panel and the CLI: how many new cards are left today, in general and per area. */
export function quotaStatus(o: { dueMinutes: number; budgetMinutes: number; cap: number; perArea: Record<string, number>; usedTotal: number; usedByArea: Map<string, number> }): QuotaStatus {
	const teto = newAllowedToday(o.dueMinutes, o.budgetMinutes, o.cap);
	const geral = { area: 'Geral', usados: o.usedTotal, teto, cap: o.cap, livres: Math.max(0, teto - o.usedTotal) };
	const areas = Object.entries(o.perArea).map(([area, t]) => {
		const usados = o.usedByArea.get(area) ?? 0;
		return { area, usados, teto: t, livres: Math.max(0, t - usados) };
	});
	return { geral, areas };
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
