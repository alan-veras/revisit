import { describe, expect, it } from 'vitest';
import { areaOf, linkPath } from '../src/cards/area';
import { mirrorPath } from '../src/cards/mirror';
import { parseAreaMap } from '../src/settings';

describe('areaOf', () => {
	it('reads the five areas from outputs and resources', () => {
		expect(areaOf('3_Outputs/Carreira/Projetos/Bolsa LiFT 2026/Cronograma do CKA/Cronograma do CKA.md')).toBe('Carreira');
		expect(areaOf('4_Resources/Desenvolvimento Pessoal/Documentos/Provas/Prova Caixa 2024.pdf')).toBe('Desenvolvimento Pessoal');
		expect(areaOf('3_Outputs/Academia/Projetos/TCC/MOC TCC.md')).toBe('Academia');
	});
	it('sends the Bible to Espiritual', () => {
		expect(areaOf('2_The Bible/NT/Hebrews/Heb 11.md')).toBe('Espiritual');
	});
	it('uses the map, longest prefix first, and returns null otherwise', () => {
		const map = { '6_Zettelkasten': 'Desenvolvimento Pessoal', '6_Zettelkasten/Teologia': 'Espiritual' };
		expect(areaOf('6_Zettelkasten/Teologia/x.md', map)).toBe('Espiritual');
		expect(areaOf('6_Zettelkasten/y.md', map)).toBe('Desenvolvimento Pessoal');
		expect(areaOf('1_bujo/2026/Daily Log/2026-11-02.md', map)).toBeNull();
		expect(areaOf('3_Outputs/Universidade/x.md')).toBeNull();
	});
});

describe('links and mirror', () => {
	it('takes the path out of a link', () => {
		expect(linkPath('[[4_Resources/x/Prova.pdf#page=12|Prova, p. 12]]')).toBe('4_Resources/x/Prova.pdf');
		expect(linkPath('sem link')).toBeNull();
	});
	it('mirrors the source path', () => {
		expect(mirrorPath('2_The Bible/NT/Hebrews/Heb 11.md', '8_System/Lembro')).toBe('8_System/Lembro/2_The Bible/NT/Hebrews/Heb 11.md');
		expect(mirrorPath('4_Resources/P/Prova.pdf', '8_System/Lembro/')).toBe('8_System/Lembro/4_Resources/P/Prova.pdf.md');
		expect(mirrorPath(null, '8_System/Lembro')).toBe('8_System/Lembro/Sem fonte.md');
	});
	it('parses the area map setting', () => {
		expect(parseAreaMap('6_Zettelkasten: Desenvolvimento Pessoal\nlixo\n')).toEqual({ '6_Zettelkasten': 'Desenvolvimento Pessoal' });
	});
});
