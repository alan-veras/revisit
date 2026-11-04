import { describe, expect, it } from 'vitest';
import { topicTree } from '../src/srs/tree';

describe('topicTree', () => {
	it('builds Área > Assunto with counts, areas in Dedicação order', () => {
		const t = topicTree([
			{ area: 'Espiritual', card: { topics: ['Hebreus'] } },
			{ area: 'Carreira', card: { topics: ['Concursos > TI', 'Java'] } },
			{ area: 'Carreira', card: { topics: ['Concursos > Português'] } },
		]);
		expect(t.map((n) => n.area)).toEqual(['Carreira', 'Espiritual']);
		const c = t[0]!;
		expect(c.cards).toBe(2);
		const conc = c.children.find((n) => n.name === 'Concursos')!;
		expect(conc.cards).toBe(2);
		expect(conc.children.map((n) => n.topic)).toEqual(['Concursos > Português', 'Concursos > TI']);
	});
});
