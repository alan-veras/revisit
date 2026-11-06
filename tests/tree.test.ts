import { describe, expect, it } from 'vitest';
import { sourceTree, topicTree } from '../src/srs/tree';

describe('sourceTree', () => {
	it('builds folder > note with counts and filters by path', () => {
		const t = sourceTree([{ source: 'Bio/Cells.md' }, { source: 'Bio/Cells.md' }, { source: 'Bio/Sub/Dna.pdf' }, { source: 'Top.md' }, { source: null }]);
		expect(t.map((n) => n.name)).toEqual(['Bio', 'No source', 'Top']);
		const bio = t[0]!;
		expect(bio.cards).toBe(3);
		expect(bio.scope).toBe('Bio');
		expect(bio.children.map((n) => [n.name, n.scope, n.cards])).toEqual([
			['Cells', 'Bio/Cells.md', 2],
			['Sub', 'Bio/Sub', 1],
		]);
		expect(bio.children[1]?.children[0]?.name).toBe('Dna.pdf');
	});
});

describe('topicTree', () => {
	it('builds Topic > subtopic with counts and leaves out cards without topics', () => {
		const t = topicTree([{ card: { topics: ['Hebrews'] } }, { card: { topics: ['Exams > IT', 'Java'] } }, { card: { topics: ['Exams > Law'] } }, { card: { topics: [] } }]);
		expect(t.map((n) => n.name)).toEqual(['Exams', 'Hebrews', 'Java']);
		const exams = t[0]!;
		expect(exams.cards).toBe(2);
		expect(exams.children.map((n) => n.topic)).toEqual(['Exams > IT', 'Exams > Law']);
	});
	it('a card counts once under a level it reaches twice', () => {
		const t = topicTree([{ card: { topics: ['Exams > IT', 'Exams > Law'] } }]);
		expect(t[0]?.cards).toBe(1);
	});
});
