/** Vault path the link inside a `Source:` points to (without `#page` or alias). */
export function linkPath(source: string): string | null {
	const m = /\[\[([^\]|#]+)/.exec(source);
	return m ? (m[1] as string).trim() : null;
}
