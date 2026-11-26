import type { DeckRow } from './decks';

/** Cards of an opened deck: today first, then the soonest back, new cards last. Ties keep their order; the input is not touched. */
export function browseOrder(rows: readonly DeckRow[]): DeckRow[] {
	const group = (r: DeckRow) => (r.today ? 0 : r.due ? 1 : 2);
	return [...rows].sort((a, b) => group(a) - group(b) || (group(a) === 1 ? (a.due as Date).getTime() - (b.due as Date).getTime() : 0));
}
