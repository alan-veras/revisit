export const CARD_TYPES = ['Question', 'Cloze', 'Reference', 'Problem'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** One flashcard as written in a card file. */
export interface Card {
	id: string | null;
	type: CardType;
	front: string;
	back: string;
	topics: string[];
	/** `#important` and the like: written only when the card has some */
	tags?: string[];
	/** also reviewed back to front */
	reverse?: boolean;
	source: string;
	/** written inside a note, which is never touched: read only */
	inline?: boolean;
	/** card file this card lives in (vault path); set by the store */
	file?: string;
	/** first and last line of the block inside its file (0-based, inclusive) */
	start: number;
	end: number;
}

export function isCardType(value: string): value is CardType {
	return (CARD_TYPES as readonly string[]).includes(value);
}

export const IMPORTANT_TAG = 'important';

/** Tags as written (`#important #exam`) into a clean list without the `#`. */
export function parseTags(value: string): string[] {
	return value
		.split(/[\s,;]+/)
		.map((t) => t.replace(/^#/, '').trim().toLowerCase())
		.filter(Boolean);
}

export function isImportant(card: Pick<Card, 'tags'> | undefined): boolean {
	return !!card?.tags?.includes(IMPORTANT_TAG);
}
