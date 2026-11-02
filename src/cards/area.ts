import { AREAS } from './types';

/** The Dedicação a source path belongs to, or null when it cannot tell. */
export function areaOf(path: string, extra: Record<string, string> = {}): string | null {
	const parts = path.split('/');
	const [root, second] = parts;
	if ((root === '3_Outputs' || root === '4_Resources') && second && (AREAS as readonly string[]).includes(second)) return second;
	if (root === '2_The Bible') return 'Espiritual';
	let best: string | null = null;
	let size = -1;
	for (const [prefix, area] of Object.entries(extra)) {
		const p = prefix.replace(/\/+$/, '');
		if ((path === p || path.startsWith(p + '/')) && p.length > size) {
			best = area;
			size = p.length;
		}
	}
	return best;
}

/** Vault path the link inside a `Fonte:` points to (without `#page` or alias). */
export function linkPath(fonte: string): string | null {
	const m = /\[\[([^\]|#]+)/.exec(fonte);
	return m ? (m[1] as string).trim() : null;
}
