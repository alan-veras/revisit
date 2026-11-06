import { RevlogEntry } from './budget';

/** Right and wrong answers per key (extra sessions included: they are real answers). */
export function cardStats(log: RevlogEntry[]): Map<string, { ok: number; bad: number }> {
	const out = new Map<string, { ok: number; bad: number }>();
	for (const e of log) {
		const s = out.get(e.id) ?? { ok: 0, bad: 0 };
		if (e.grade === 1) s.bad++;
		else s.ok++;
		out.set(e.id, s);
	}
	return out;
}

/**
 * Retention: share of answers that were not "Again", over reviews of cards that
 * had been seen at least 7 days before (mature), grouped by `group(id)`.
 */
export function retentionBy(log: RevlogEntry[], group: (id: string) => string | null): Map<string, { ok: number; total: number }> {
	const last = new Map<string, number>();
	const out = new Map<string, { ok: number; total: number }>();
	for (const e of log) {
		const t = new Date(e.t).getTime();
		const prev = last.get(e.id);
		if (!e.extra) last.set(e.id, t);
		if (e.extra || prev === undefined || t - prev < 7 * 86400000) continue;
		const g = group(e.id);
		if (!g) continue;
		const r = out.get(g) ?? { ok: 0, total: 0 };
		r.total++;
		if (e.grade !== 1) r.ok++;
		out.set(g, r);
	}
	return out;
}

/** Grades per local day for the last `days` days, oldest first. */
export function reviewsPerDay(log: RevlogEntry[], now: Date, days = 30): number[] {
	const out = new Array<number>(days).fill(0);
	const today = new Date(now);
	today.setHours(0, 0, 0, 0);
	for (const e of log) {
		const d = new Date(e.t);
		d.setHours(0, 0, 0, 0);
		const ago = Math.round((today.getTime() - d.getTime()) / 86400000);
		if (ago >= 0 && ago < days) out[days - 1 - ago] = (out[days - 1 - ago] ?? 0) + 1;
	}
	return out;
}

/** Cards seen for the first time per week (Monday start), last `weeks` weeks, oldest first. */
export function newPerWeek(log: RevlogEntry[], now: Date, weeks = 8): number[] {
	const out = new Array<number>(weeks).fill(0);
	const mondayOf = (d: Date) => {
		const m = new Date(d);
		m.setHours(0, 0, 0, 0);
		m.setDate(m.getDate() - ((m.getDay() + 6) % 7));
		return m.getTime();
	};
	const thisWeek = mondayOf(now);
	const seen = new Set<string>();
	for (const e of log) {
		if (!e.new || e.extra || seen.has(e.id)) continue;
		seen.add(e.id);
		const ago = Math.round((thisWeek - mondayOf(new Date(e.t))) / (7 * 86400000));
		if (ago >= 0 && ago < weeks) out[weeks - 1 - ago] = (out[weeks - 1 - ago] ?? 0) + 1;
	}
	return out;
}

/** Folder a source belongs to in the statistics: its first `depth` folder levels. */
export function folderGroup(path: string, depth = 2): string {
	const parts = path.split('/').slice(0, -1).slice(0, depth);
	return parts.length ? parts.join('/') : '/';
}

/** The groups with the most reviews, best for a short chart. */
export function topGroups(ret: Map<string, { ok: number; total: number }>, max = 8): [string, { ok: number; total: number }][] {
	return [...ret.entries()].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])).slice(0, max);
}
