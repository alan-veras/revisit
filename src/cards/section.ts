/** Text of the nearest heading at or above a line, or null. */
export function headingAbove(text: string, line: number): string | null {
	const lines = text.split('\n');
	for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
		const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
		if (m) return (m[1] as string).replace(/[[\]|#^]/g, '').trim() || null;
	}
	return null;
}

/** Section named in a source link (`[[note#Section|...]]`), never a PDF page. */
export function sectionOf(source: string): string | null {
	const m = /\[\[[^\]|#]*#([^\]|]+)/.exec(source);
	return m && !m[1]?.startsWith('page=') ? (m[1] as string) : null;
}
