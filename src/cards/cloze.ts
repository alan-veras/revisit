/** Highlights `==texto==` in the front of a Lacuna: each one is a card of its own. */
const CLOZE_RE = /==([^=\n]+?)==/g;

export function clozes(text: string): string[] {
	return [...text.matchAll(CLOZE_RE)].map((m) => (m[1] as string).trim());
}

/** The front with highlight `i` hidden as `___` and the others shown as plain text. */
export function hideCloze(text: string, i: number): string {
	let n = 0;
	return text.replace(CLOZE_RE, (_m, inner: string) => (n++ === i ? '___' : inner));
}
