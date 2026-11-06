import type { RevlogEntry } from '../srs/budget';
import type { CardState } from './Store';
import { migrateEstado, migrateLogEntry } from './migrate';

/** Reads the state file; anything but an object counts as corruption and throws, so the caller can fall back to the backup. The old schema is migrated on the way in. */
export function parseStateText(text: string): { state: Record<string, CardState>; changed: boolean } {
	const v: unknown = JSON.parse(text);
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the content is not an object');
	return migrateEstado(v as Record<string, unknown>);
}

/**
 * Reads the review log skipping lines that do not parse, so one bad line never
 * kills the history. Every line is normalized to the English field names (the
 * reader accepts the old Portuguese ones forever) and the raw lines come back
 * too, so undo can rewrite the file without touching the bytes of the kept lines.
 */
export function parseLogLines(text: string): { entries: RevlogEntry[]; bad: number; lines: string[] } {
	const entries: RevlogEntry[] = [];
	const lines: string[] = [];
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
			entries.push(migrateLogEntry(parsed));
			lines.push(line);
		} catch {
			bad++;
		}
	}
	return { entries, bad, lines };
}
