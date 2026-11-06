import { describe, expect, it } from 'vitest';
import { linkPath } from '../src/cards/link';
import { mirrorPath } from '../src/cards/mirror';

describe('links and mirror', () => {
	it('takes the path out of a link', () => {
		expect(linkPath('[[Library/x/Exam.pdf#page=12|Exam, p. 12]]')).toBe('Library/x/Exam.pdf');
		expect(linkPath('no link')).toBeNull();
	});
	it('mirrors the source path', () => {
		expect(mirrorPath('Books/NT/Hebrews/Heb 11.md', 'Revisit')).toBe('Revisit/Books/NT/Hebrews/Heb 11.md');
		expect(mirrorPath('Library/P/Exam.pdf', 'Revisit/')).toBe('Revisit/Library/P/Exam.pdf.md');
		expect(mirrorPath(null, 'Revisit')).toBe('Revisit/No source.md');
	});
});
