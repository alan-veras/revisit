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
 * Reads review-log.jsonl skipping lines that do not parse. The raw lines come back
 * too, so undo can rewrite the file without touching the bytes of the kept lines.
 */
export function parseLogLines(text: string): { entries: RevlogEntry[]; lines: string[]; bad: number } {
	const entries: RevlogEntry[] = [];
	const lines: string[] = [];
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
			entries.push(toEntry(parsed as Record<string, unknown>));
			lines.push(line);
		} catch {
			bad++;
		}
	}
	return { entries, lines, bad };
}
