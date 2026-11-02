import { describe, expect, it } from 'vitest';
import { headingAbove, sectionOf } from '../src/cards/section';
import { clozes, hideCloze } from '../src/cards/cloze';
import { baseOf, buryGemeos, QueueItem } from '../src/srs/queue';

describe('lacunas por destaque', () => {
	it('acha e esconde cada destaque', () => {
		const t = 'A ==fé== é a ==certeza== do que se espera';
		expect(clozes(t)).toEqual(['fé', 'certeza']);
		expect(hideCloze(t, 1)).toBe('A fé é a ___ do que se espera');
	});
	it('irmãos da mesma lacuna não caem juntos', () => {
		const it = (key: string) => ({ key, reverso: false, card: { id: 'labcde' }, area: null, suspended: false }) as unknown as QueueItem;
		expect(baseOf('labcde-c2')).toBe('labcde');
		expect(buryGemeos([it('labcde'), it('labcde-c2')], new Set()).map((i) => i.key)).toEqual(['labcde']);
		expect(buryGemeos([it('labcde-c2')], new Set(['labcde'])).map((i) => i.key)).toEqual([]);
	});
});

describe('seção da fonte', () => {
	it('acha o título acima da linha', () => {
		expect(headingAbove('# A\ntexto\n## B\nmais', 3)).toBe('B');
		expect(headingAbove('sem título', 0)).toBe(null);
	});
	it('lê a seção do link, mas não a página do PDF', () => {
		expect(sectionOf('[[x/Nota#Fé|Nota]]')).toBe('Fé');
		expect(sectionOf('[[x.pdf#page=3|x]]')).toBe(null);
	});
});
