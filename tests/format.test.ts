import { describe, expect, it } from 'vitest';
import { appendCard, appendCards, ensureIds, groupBy, normalizeAssunto, parseCardFile, removeCard, renameSource, renameSourceFolder, replaceCard, serializeCard } from '../src/cards/format';

const FILE = `Frente: Como desfazer o último rollout de um deployment?
Verso:
\`\`\`bash
kubectl rollout undo deployment/web
---
\`\`\`
Para voltar a uma revisão, \`--to-revision=2\`.
Tipo: Pergunta
Assunto: Kubernetes > Workloads; CKA
Fonte: [[3_Outputs/Carreira/Projetos/Bolsa LiFT 2026/Cronograma do CKA/Cronograma do CKA|Cronograma do CKA]] ^lk7q2a

---

Frente: Hebreus 11:1
Verso: Ora, a fé é a certeza daquilo que esperamos.
Tipo: Referência
Fonte: [[2_The Bible/NT/Hebrews/Heb 11|Heb 11]] ^lab12c
`;

describe('parseCardFile', () => {
	it('reads blocks, multi-line backs and ignores --- inside code', () => {
		const cards = parseCardFile(FILE);
		expect(cards).toHaveLength(2);
		const [a, b] = cards;
		expect(a?.id).toBe('lk7q2a');
		expect(a?.verso).toContain('kubectl rollout undo');
		expect(a?.verso).toContain('--to-revision=2');
		expect(a?.assuntos).toEqual(['Kubernetes > Workloads', 'CKA']);
		expect(a?.fonte).toBe('[[3_Outputs/Carreira/Projetos/Bolsa LiFT 2026/Cronograma do CKA/Cronograma do CKA|Cronograma do CKA]]');
		expect(b?.tipo).toBe('Referência');
		expect(b?.id).toBe('lab12c');
	});

	it('defaults the type and skips blocks without front or back', () => {
		const cards = parseCardFile('Frente: só frente\n\n---\n\nFrente: a\nVerso: b\nTipo: Inventado\n');
		expect(cards).toHaveLength(1);
		expect(cards[0]?.tipo).toBe('Pergunta');
	});

	it('reads an explicit area', () => {
		const [c] = parseCardFile('Frente: a\nVerso: b\nÁrea: Academia\n');
		expect(c?.area).toBe('Academia');
	});
});

describe('serialize and edit', () => {
	it('round trips a card', () => {
		const block = serializeCard({ id: 'labcde', tipo: 'Questão', frente: 'Enunciado\n(A) x', verso: '(B) y', assuntos: ['Concursos > TI'], fonte: '[[p.pdf#page=3|p, p. 3]]' });
		const [c] = parseCardFile(block);
		expect(c).toMatchObject({ id: 'labcde', tipo: 'Questão', frente: 'Enunciado\n(A) x', verso: '(B) y', assuntos: ['Concursos > TI'] });
	});

	it('puts the id on the last line when there is no source', () => {
		const block = serializeCard({ id: 'lzzzzz', tipo: 'Pergunta', frente: 'a', verso: 'b', assuntos: [], fonte: '' });
		expect(block.split('\n').pop()).toBe('Tipo: Pergunta ^lzzzzz');
	});

	it('appends, replaces and removes', () => {
		let text = appendCard('', serializeCard({ id: 'laaaaa', tipo: 'Pergunta', frente: 'um', verso: '1', assuntos: [], fonte: '' }));
		text = appendCard(text, serializeCard({ id: 'lbbbbb', tipo: 'Pergunta', frente: 'dois', verso: '2', assuntos: [], fonte: '' }));
		expect(parseCardFile(text).map((c) => c.frente)).toEqual(['um', 'dois']);
		const second = parseCardFile(text)[1];
		if (!second) throw new Error('no card');
		text = replaceCard(text, second, serializeCard({ ...second, frente: 'dois editado' }));
		expect(parseCardFile(text).map((c) => c.frente)).toEqual(['um', 'dois editado']);
		const first = parseCardFile(text)[0];
		if (!first) throw new Error('no card');
		text = removeCard(text, first);
		expect(parseCardFile(text).map((c) => c.id)).toEqual(['lbbbbb']);
	});
});

describe('ensureIds', () => {
	it('gives ids only to cards without one, without collision', () => {
		const text = 'Frente: a\nVerso: b\n\n---\n\nFrente: c\nVerso: d ^lxxxxx\n';
		const taken = new Set(['lxxxxx']);
		const out = ensureIds(text, taken);
		expect(out.added).toBe(1);
		const ids = parseCardFile(out.text).map((c) => c.id);
		expect(ids[1]).toBe('lxxxxx');
		expect(ids[0]).toMatch(/^l[a-z0-9]{5}$/);
		expect(ids[0]).not.toBe('lxxxxx');
	});

	it('leaves a complete file unchanged', () => {
		expect(ensureIds(FILE, new Set()).text).toBe(FILE);
	});

	it('verso terminando em code fence recebe o id fora da fence e converge', () => {
		const text = 'Frente: O que faz o comando?\nVerso:\n```bash\nkubectl rollout undo\n```\nTipo: Pergunta\n';
		const taken = new Set<string>();
		const first = ensureIds(text, taken);
		expect(first.added).toBe(1);
		expect(first.text).not.toContain('``` ^');
		const again = ensureIds(first.text, taken);
		expect(again.added).toBe(0);
		const [c] = parseCardFile(first.text);
		expect(c?.id).toMatch(/^l[a-z0-9]{5}$/);
		expect(c?.verso).toContain('kubectl rollout undo');
		expect(c?.tipo).toBe('Pergunta');
	});

	it('verso que é só code fence recebe o id numa linha de campo que aguenta', () => {
		const text = 'Frente: a\nVerso:\n```bash\nls\n```\n';
		const { text: out, added } = ensureIds(text, new Set());
		expect(added).toBe(1);
		const [c] = parseCardFile(out);
		expect(c?.id).toMatch(/^l[a-z0-9]{5}$/);
		expect(c?.verso).toContain('ls');
	});
});

describe('removeCard com frontmatter', () => {
	it('preserva o frontmatter ao remover o primeiro cartão', () => {
		const text = '---\ntags: [lembro]\n---\n\nFrente: A\nVerso: B\n\n---\n\nFrente: C\nVerso: D\n';
		const [first] = parseCardFile(text);
		if (!first) throw new Error('no card');
		const out = removeCard(text, first);
		expect(out.startsWith('---\ntags: [lembro]\n---')).toBe(true);
		expect(parseCardFile(out).map((c) => c.frente)).toEqual(['C']);
	});

	it('não colapsa linhas vazias dentro de fences de outros cartões', () => {
		const text = 'Frente: A\nVerso: a\n\n---\n\nFrente: B\nVerso:\n```js\n\n\n\nf()\n```\nTipo: Pergunta\n';
		const [first] = parseCardFile(text);
		if (!first) throw new Error('no card');
		const out = removeCard(text, first);
		expect(out).toContain('```js\n\n\n\nf()');
	});
});

describe('normalizeAssunto', () => {
	it('trims the levels', () => {
		expect(normalizeAssunto(' Concursos>TI  >  Árvores ')).toBe('Concursos > TI > Árvores');
	});
	it('reads and writes Reverso', () => {
		const c = parseCardFile('Frente: a\nVerso: b\nReverso: sim ^labcde')[0];
		expect(c?.reverso).toBe(true);
		expect(serializeCard({ ...(c as NonNullable<typeof c>) })).toContain('Reverso: sim ^labcde');
	});
	it('renames a source link', () => {
		const t = 'Frente: a\nVerso: b\nFonte: [[3_Outputs/X/Nota|Nota]] ^labcde\n\n---\n\nFonte: [[Outra]]';
		const out = renameSource(t, '3_Outputs/X/Nota.md', '3_Outputs/Y/Nova.md');
		expect(out).toContain('[[3_Outputs/Y/Nova|Nota]] ^labcde');
		expect(out).toContain('[[Outra]]');
		expect(renameSource('Fonte: [[a.pdf#page=3|a, p. 3]]', 'a.pdf', 'b/a.pdf')).toBe('Fonte: [[b/a.pdf#page=3|a, p. 3]]');
	});

	it('renames links de uma pasta inteira', () => {
		const t = 'Fonte: [[Pasta Antiga/Nota|Nota]]\nFonte: [[Pasta Antiga]]\nFonte: [[Outro Lugar/Nota]]';
		const out = renameSourceFolder(t, 'Pasta Antiga', 'Novo Lugar');
		expect(out).toContain('[[Novo Lugar/Nota|Nota]]');
		expect(out).toContain('[[Novo Lugar]]');
		expect(out).toContain('[[Outro Lugar/Nota]]');
		expect(renameSourceFolder('Fonte: [[P/A.pdf#page=2|p]]', 'P', 'Q')).toBe('Fonte: [[Q/A.pdf#page=2|p]]');
	});
});

describe('lote numa escrita só', () => {
	it('appendCards junta os blocos em ordem, igual a vários appendCard', () => {
		const one = appendCard(appendCard('Frente: A\nVerso: a', 'Frente: B\nVerso: b'), 'Frente: C\nVerso: c');
		expect(appendCards('Frente: A\nVerso: a', ['Frente: B\nVerso: b', 'Frente: C\nVerso: c'])).toBe(one);
		expect(parseCardFile(appendCards('', ['Frente: B\nVerso: b', 'Frente: C\nVerso: c']))).toHaveLength(2);
	});
	it('groupBy mantém a ordem dos destinos e dos itens', () => {
		const g = groupBy(['a1', 'b1', 'a2', 'c1', 'b2'], (x) => x[0] as string);
		expect([...g.keys()]).toEqual(['a', 'b', 'c']);
		expect(g.get('a')).toEqual(['a1', 'a2']);
	});
});

describe('Tags', () => {
	it('lê e grava a linha Tags só quando existe', () => {
		const base = { id: 'lab123', tipo: 'Pergunta' as const, frente: 'f', verso: 'v', assuntos: [], fonte: '' };
		const text = serializeCard({ ...base, tags: ['importante'] });
		expect(text).toContain('Tags: #importante');
		expect(parseCardFile(text)[0]?.tags).toEqual(['importante']);
		expect(serializeCard(base)).not.toContain('Tags:');
		expect(parseCardFile(serializeCard(base))[0]?.tags).toBeUndefined();
	});
});

it('assuntosLabel mostra só o último nível', async () => {
	const { assuntosLabel } = await import('../src/cards/format');
	expect(assuntosLabel(['Sustento > Perseguição', 'Kubernetes'])).toBe('Perseguição; Kubernetes');
});
