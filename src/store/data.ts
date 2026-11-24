import type { CardState, RevlogEntry } from '../core/types';

/** Reads state.json; anything but an object counts as corruption and throws, so the caller can fall back to the backup. Unknown entries are kept as they are. */
export function parseStateText(text: string): Record<string, CardState> {
	const v: unknown = JSON.parse(text);
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the content is not an object');
	return v as Record<string, CardState>;
}

/** One log line; the Portuguese field names of old versions (`nota`, `segundos`, `tipo`, `novo`, `estado`) are read forever. */
function toEntry(raw: Record<string, unknown>): RevlogEntry {
	const str = (x: unknown) => (typeof x === 'string' ? x : '');
	const type = str(raw.type ?? raw.tipo);
	const entry: RevlogEntry = {
		id: str(raw.id),
		t: str(raw.t),
		grade: Number(raw.grade ?? raw.nota ?? 0),
		seconds: Number(raw.seconds ?? raw.segundos ?? 0),
		type: ({ Questão: 'Question', Lacuna: 'Cloze', Referência: 'Reference', Problema: 'Problem' } as Record<string, string>)[type] ?? type,
		new: Boolean(raw.new ?? raw.novo),
		extra: Boolean(raw.extra),
	};
	const state = raw.state ?? raw.estado;
	if (state !== undefined) entry.state = Number(state);
	return entry;
}

/**
 * Reads review-log.jsonl skipping lines that do not parse.
 */
export function parseLogLines(text: string): { entries: RevlogEntry[]; bad: number } {
	const entries: RevlogEntry[] = [];
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
			entries.push(toEntry(parsed as Record<string, unknown>));
		} catch {
			bad++;
		}
	}
	return { entries, bad };
}

/** Syncthing keeps the losing copy of a file written on two devices as `name.sync-conflict-…`; those are never read. */
export function isConflictPath(path: string): boolean {
	return path.includes('.sync-conflict-');
}

/** The vault folder of the per-device files; never a deck. */
export const DEVICES_DIR = 'devices';

/** Short readable id of this device (6 characters). */
export function newDeviceId(random: () => number = Math.random): string {
	const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
	return Array.from({ length: 6 }, () => chars[Math.floor(random() * chars.length)]).join('');
}

const reviewedAt = (s: CardState | undefined): number => {
	const t = s?.fsrs?.last_review ? Date.parse(s.fsrs.last_review) : NaN;
	return Number.isNaN(t) ? -Infinity : t;
};

/** Merges state layers (oldest layer first): per card key the entry with the latest last_review wins; on a tie the later layer wins. */
export function mergeStates(layers: Record<string, CardState>[]): Record<string, CardState> {
	const out: Record<string, CardState> = {};
	for (const layer of layers) {
		for (const [key, entry] of Object.entries(layer)) {
			const have = out[key];
			if (!have || reviewedAt(entry) >= reviewedAt(have)) out[key] = entry;
		}
	}
	return out;
}

/** Joins log layers into one list ordered by time (stable for equal times). */
export function mergeLogs(layers: RevlogEntry[][]): RevlogEntry[] {
	return layers.flat().sort((a, b) => Date.parse(a.t) - Date.parse(b.t) || 0);
}
