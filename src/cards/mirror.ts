/** Characters a vault file or folder name cannot carry (they break sync on mobile). */
const FORBIDDEN = /[:_"<>|?*\\/]/g;

export const NO_DECK = 'No deck';

/**
 * File of a deck: the first topic of the card becomes the path under the folder,
 * `A > B` turning into `A/B.md`. A card without a topic goes to `No deck.md`.
 */
export function deckPath(topics: readonly string[], folder: string): string {
	const base = folder.replace(/\/+$/, '');
	const rel = (topics[0] ?? '')
		.split(' > ')
		.map((part) => part.replace(FORBIDDEN, '-').trim())
		.filter(Boolean)
		.join('/');
	return `${base}/${rel || NO_DECK}.md`;
}
