/** Card file for a source: `<folder>/<source path>.md` (a PDF keeps its `.pdf`). */
export function mirrorPath(source: string | null, folder: string): string {
	const base = folder.replace(/\/+$/, '');
	if (!source) return `${base}/No source.md`;
	const rel = source.replace(/\.md$/, '');
	return `${base}/${rel}.md`;
}
