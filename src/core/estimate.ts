import type { RevlogEntry } from './types';

/** how many of the latest timed answers are looked at */
const SAMPLE = 200;
/** fewer than this and the average says little: the default is used */
const MIN_SAMPLE = 20;
const DEFAULT_SECONDS = 10;
/** a card left open on the screen counts as this much at most */
const MAX_SECONDS = 60;
const DEFAULT_REPEAT = 1.3;
const MAX_MINUTES = 180;

/** Minutes to go through `count` cards, repeats included, rounded up; null when there is nothing to review. */
export function estimateMinutes(count: number, log: RevlogEntry[]): number | null {
	if (count <= 0) return null;
	const sample = log.filter((e) => e.seconds > 0).slice(-SAMPLE);
	const seconds = sample.length >= MIN_SAMPLE ? sample.reduce((sum, e) => sum + Math.min(e.seconds, MAX_SECONDS), 0) / sample.length : DEFAULT_SECONDS;
	// answers per card per day: how often a card really came back
	const pairs = new Set(sample.map((e) => `${e.id} ${new Date(e.t).toDateString()}`)).size;
	const repeat = pairs ? Math.min(2, Math.max(1, sample.length / pairs)) : DEFAULT_REPEAT;
	return Math.max(1, Math.ceil((count * seconds * repeat) / 60));
}

/** A typed length: whole minutes from 1 to 180; null when it is not one. */
export function parseMinutes(text: string): number | null {
	const n = Math.round(Number(text));
	return n >= 1 ? Math.min(MAX_MINUTES, n) : null;
}
