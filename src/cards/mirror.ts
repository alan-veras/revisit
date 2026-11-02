/** Card file for a source: `<pasta>/<source path>.md` (a PDF keeps its `.pdf`). */
export function mirrorPath(source: string | null, folder: string): string {
	const base = folder.replace(/\/+$/, '');
	if (!source) return `${base}/Sem fonte.md`;
	const rel = source.replace(/\.md$/, '');
	return `${base}/${rel}.md`;
}
