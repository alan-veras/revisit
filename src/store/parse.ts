import type { RevlogEntry } from '../srs/budget';
import type { CardState } from './Store';

/** Reads estado.json; anything but an object counts as corruption and throws, so the caller can fall back to the backup. */
export function parseStateText(text: string): Record<string, CardState> {
	const v: unknown = JSON.parse(text);
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the content is not an object');
	return v as Record<string, CardState>;
}

/** Reads revisoes.jsonl skipping lines that do not parse, so one bad line never kills the history. */
export function parseLogLines(text: string): { entries: RevlogEntry[]; bad: number } {
	const entries: RevlogEntry[] = [];
	let bad = 0;
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as RevlogEntry);
		} catch {
			bad++;
		}
	}
	return { entries, bad };
}
