import { describe, expect, it } from 'vitest';
import { assuntoTree } from '../src/srs/tree';

describe('assuntoTree', () => {
	it('builds Área > Assunto with counts, areas in Dedicação order', () => {
		const t = assuntoTree([
			{ area: 'Espiritual', card: { assuntos: ['Hebreus'] } },
			{ area: 'Carreira', card: { assuntos: ['Concursos > TI', 'Java'] } },
			{ area: 'Carreira', card: { assuntos: ['Concursos > Português'] } },
		]);
		expect(t.map((n) => n.area)).toEqual(['Carreira', 'Espiritual']);
		const c = t[0]!;
		expect(c.cards).toBe(2);
		const conc = c.children.find((n) => n.name === 'Concursos')!;
		expect(conc.cards).toBe(2);
		expect(conc.children.map((n) => n.assunto)).toEqual(['Concursos > Português', 'Concursos > TI']);
	});
});
