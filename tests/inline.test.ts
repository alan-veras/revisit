import { describe, expect, it } from 'vitest';
import { inlineId, parseInlineCards } from '../src/cards/inline';

const NOTE = `---
tags: [flashcards]
alias:: not a card
---
# Heading::not a card

Capital of France::Paris
- Bonjour:::Hello <!--SR:!2026-12-01,3,250-->
The ==mitochondrion== makes ==ATP==.
Plain line.
Use \`std::vector\` here.
See [[a::b]] there.
::no front
no back::

\`\`\`
in::code
\`\`\`
Capital of France::Again
`;

describe('parseInlineCards', () => {
	const cards = parseInlineCards(NOTE, '[[Note|Note]]');
	it('reads the three forms, only', () => {
		expect(cards.map((c) => [c.type, c.front, c.back, !!c.reverse])).toEqual([
			['Question', 'Capital of France', 'Paris', false],
			['Question', 'Bonjour', 'Hello', true],
			['Cloze', 'The ==mitochondrion== makes ==ATP==.', '', false],
		]);
	});
	it('marks them read only, with the note as the source', () => {
		for (const c of cards) {
			expect(c.inline).toBe(true);
			expect(c.source).toBe('[[Note|Note]]');
		}
	});
	it('the id follows the front, not the line', () => {
		const moved = parseInlineCards(`intro\n\n\nCapital of France::Paris, France`, '[[Other|Other]]');
		expect(moved[0]?.id).toBe(cards[0]?.id);
		expect(cards[0]?.id).toBe(inlineId('Capital of France'));
		expect(cards[0]?.id).toMatch(/^i[a-z0-9]+$/);
		expect(inlineId('a')).not.toBe(inlineId('b'));
	});
	it('reads text with no frontmatter or cards', () => {
		expect(parseInlineCards('', '[[x]]')).toEqual([]);
		expect(parseInlineCards('Just prose: with a colon.', '[[x]]')).toEqual([]);
	});
});
