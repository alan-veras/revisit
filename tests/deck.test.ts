import { describe, expect, it } from 'vitest';
import { linkPath } from '../src/cards/link';
import { deckPath } from '../src/cards/mirror';
import { planDeckMigration } from '../src/store/migrate';

describe('links and deck paths', () => {
	it('takes the path out of a link', () => {
		expect(linkPath('[[Library/x/Exam.pdf#page=12|Exam, p. 12]]')).toBe('Library/x/Exam.pdf');
		expect(linkPath('no link')).toBeNull();
	});
	it('turns the first topic into the deck file', () => {
		expect(deckPath(['AWS > IA Generativa'], 'Revisit')).toBe('Revisit/AWS/IA Generativa.md');
		expect(deckPath(['A', 'B'], 'Revisit')).toBe('Revisit/A.md');
	});
	it('goes to No deck without a topic', () => {
		expect(deckPath([], 'Revisit')).toBe('Revisit/No deck.md');
		expect(deckPath(['   '], 'Revisit')).toBe('Revisit/No deck.md');
	});
	it('replaces the characters a filename cannot carry', () => {
		expect(deckPath(['A > B:C'], 'Revisit')).toBe('Revisit/A/B-C.md');
		expect(deckPath(['A/B'], 'Revisit')).toBe('Revisit/A-B.md');
		expect(deckPath(['A > B > C'], 'Revisit/')).toBe('Revisit/A/B/C.md');
	});
});

const card = (front: string, topic: string, id: string): string =>
	`Front: ${front}\nBack: a\nTopic: ${topic}\nSource: [[n|n]] ^${id}\n`;

describe('planDeckMigration', () => {
	it('moves blocks verbatim to the deck file and empties the sources', () => {
		const a = card('q1', 'AWS > IA', 'laaaaa');
		const b = card('q2', 'AWS > IA', 'lbbbbb');
		const plan = planDeckMigration(
			[
				{ path: 'Revisit/Old/A.md', text: a },
				{ path: 'Revisit/Old/B.md', text: b },
			],
			'Revisit',
		);
		expect(plan.removes).toEqual(['Revisit/Old/A.md', 'Revisit/Old/B.md']);
		expect(plan.writes).toHaveLength(1);
		expect(plan.writes[0]?.path).toBe('Revisit/AWS/IA.md');
		expect(plan.writes[0]?.text).toContain('Front: q1');
		expect(plan.writes[0]?.text).toContain('---');
		expect(plan.writes[0]?.text).toContain('^laaaaa');
		expect(plan.writes[0]?.text).toContain('^lbbbbb');
		expect(plan.backups.map((x) => x.target)).toEqual(['Revisit/Old/A.md.backup-pre-deck', 'Revisit/Old/B.md.backup-pre-deck']);
	});

	it('keeps a card already in its deck file and receives others there', () => {
		const home = card('q1', 'AWS', 'laaaaa');
		const away = card('q2', 'AWS', 'lbbbbb');
		const plan = planDeckMigration(
			[
				{ path: 'Revisit/AWS.md', text: home },
				{ path: 'Revisit/Old/B.md', text: away },
			],
			'Revisit',
		);
		expect(plan.removes).toEqual(['Revisit/Old/B.md']);
		const w = plan.writes.find((x) => x.path === 'Revisit/AWS.md');
		expect(w?.text).toContain('Front: q1');
		expect(w?.text).toContain('Front: q2');
	});

	it('sends a card without a topic to No deck.md', () => {
		const block = 'Front: q1\nBack: a\nSource: [[n|n]] ^laaaaa\n';
		const plan = planDeckMigration([{ path: 'Revisit/Old/A.md', text: block }], 'Revisit');
		expect(plan.writes[0]?.path).toBe('Revisit/No deck.md');
		expect(plan.removes).toEqual(['Revisit/Old/A.md']);
	});

	it('uses the first topic of a multi-topic card', () => {
		const block = card('q1', 'AWS > IA; FSRS', 'laaaaa');
		const plan = planDeckMigration([{ path: 'Revisit/Old/A.md', text: block }], 'Revisit');
		expect(plan.writes[0]?.path).toBe('Revisit/AWS/IA.md');
		expect(plan.writes[0]?.text).toContain('Topic: AWS > IA; FSRS');
	});

	it('keeps a file that only loses some of its cards and never deletes one that receives', () => {
		const keeper = `${card('q1', 'AWS', 'laaaaa')}\n---\n\n${card('q2', 'K8s', 'lbbbbb')}\n`;
		const donor = card('q3', 'AWS', 'lccccc');
		const plan = planDeckMigration(
			[
				{ path: 'Revisit/AWS.md', text: keeper },
				{ path: 'Revisit/Old/B.md', text: donor },
			],
			'Revisit',
		);
		expect(plan.removes).toEqual(['Revisit/Old/B.md']);
		const w = plan.writes.find((x) => x.path === 'Revisit/AWS.md');
		expect(w?.text).not.toContain('Front: q2');
		expect(w?.text).toContain('Front: q1');
		expect(w?.text).toContain('Front: q3');
	});

	it('plans nothing for a vault already on the deck layout', () => {
		const home = card('q1', 'AWS', 'laaaaa');
		const plan = planDeckMigration([{ path: 'Revisit/AWS.md', text: home }], 'Revisit');
		expect(plan.writes).toEqual([]);
		expect(plan.removes).toEqual([]);
		expect(plan.backups).toEqual([]);
	});
});
