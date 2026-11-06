import { describe, expect, it } from 'vitest';
import { appendCard, appendCards, ensureIds, groupBy, normalizeTopic, parseCardFile, removeCard, renameSource, renameSourceFolder, replaceCard, retagTopics, rewriteTopics, serializeCard } from '../src/cards/format';

const FILE = `Front: Como desfazer o último rollout de um deployment?
Back:
\`\`\`bash
kubectl rollout undo deployment/web
---
\`\`\`
Para voltar a uma revisão, \`--to-revision=2\`.
Type: Question
Topic: Kubernetes > Workloads; CKA
Source: [[Work/CKA/CKA study plan|Cronograma do CKA]] ^lk7q2a

---

Front: Hebreus 11:1
Back: Ora, a fé é a certeza daquilo que esperamos.
Type: Reference
Source: [[Books/NT/Hebrews/Heb 11|Heb 11]] ^lab12c
`;

describe('parseCardFile', () => {
	it('reads blocks, multi-line backs and ignores --- inside code', () => {
		const cards = parseCardFile(FILE);
		expect(cards).toHaveLength(2);
		const [a, b] = cards;
		expect(a?.id).toBe('lk7q2a');
		expect(a?.back).toContain('kubectl rollout undo');
		expect(a?.back).toContain('--to-revision=2');
		expect(a?.topics).toEqual(['Kubernetes > Workloads', 'CKA']);
		expect(a?.source).toBe('[[Work/CKA/CKA study plan|Cronograma do CKA]]');
		expect(b?.type).toBe('Reference');
		expect(b?.id).toBe('lab12c');
	});

	it('defaults the type and skips blocks without front or back', () => {
		const cards = parseCardFile('Front: só front\n\n---\n\nFront: a\nBack: b\nType: Made up\n');
		expect(cards).toHaveLength(1);
		expect(cards[0]?.type).toBe('Question');
	});

	it('reads the English labels only', () => {
		expect(parseCardFile('Frente: a\nVerso: b\n')).toHaveLength(0);
	});
});

describe('serialize and edit', () => {
	it('round trips a card', () => {
		const block = serializeCard({ id: 'labcde', type: 'Problem', front: 'Enunciado\n(A) x', back: '(B) y', topics: ['Concursos > TI'], source: '[[p.pdf#page=3|p, p. 3]]' });
		const [c] = parseCardFile(block);
		expect(c).toMatchObject({ id: 'labcde', type: 'Problem', front: 'Enunciado\n(A) x', back: '(B) y', topics: ['Concursos > TI'] });
	});

	it('puts the id on the last line when there is no source', () => {
		const block = serializeCard({ id: 'lzzzzz', type: 'Question', front: 'a', back: 'b', topics: [], source: '' });
		expect(block.split('\n').pop()).toBe('Type: Question ^lzzzzz');
	});

	it('appends, replaces and removes', () => {
		let text = appendCard('', serializeCard({ id: 'laaaaa', type: 'Question', front: 'um', back: '1', topics: [], source: '' }));
		text = appendCard(text, serializeCard({ id: 'lbbbbb', type: 'Question', front: 'dois', back: '2', topics: [], source: '' }));
		expect(parseCardFile(text).map((c) => c.front)).toEqual(['um', 'dois']);
		const second = parseCardFile(text)[1];
		if (!second) throw new Error('no card');
		text = replaceCard(text, second, serializeCard({ ...second, front: 'dois editado' }));
		expect(parseCardFile(text).map((c) => c.front)).toEqual(['um', 'dois editado']);
		const first = parseCardFile(text)[0];
		if (!first) throw new Error('no card');
		text = removeCard(text, first);
		expect(parseCardFile(text).map((c) => c.id)).toEqual(['lbbbbb']);
	});
});

describe('ensureIds', () => {
	it('gives ids only to cards without one, without collision', () => {
		const text = 'Front: a\nBack: b\n\n---\n\nFront: c\nBack: d ^lxxxxx\n';
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

	it('back terminando em code fence recebe o id fora da fence e converge', () => {
		const text = 'Front: O que faz o comando?\nBack:\n```bash\nkubectl rollout undo\n```\nType: Question\n';
		const taken = new Set<string>();
		const first = ensureIds(text, taken);
		expect(first.added).toBe(1);
		expect(first.text).not.toContain('``` ^');
		const again = ensureIds(first.text, taken);
		expect(again.added).toBe(0);
		const [c] = parseCardFile(first.text);
		expect(c?.id).toMatch(/^l[a-z0-9]{5}$/);
		expect(c?.back).toContain('kubectl rollout undo');
		expect(c?.type).toBe('Question');
	});

	it('back que é só code fence recebe o id numa linha de campo que aguenta', () => {
		const text = 'Front: a\nBack:\n```bash\nls\n```\n';
		const { text: out, added } = ensureIds(text, new Set());
		expect(added).toBe(1);
		const [c] = parseCardFile(out);
		expect(c?.id).toMatch(/^l[a-z0-9]{5}$/);
		expect(c?.back).toContain('ls');
	});
});

describe('removeCard com frontmatter', () => {
	it('preserva o frontmatter ao remover o primeiro cartão', () => {
		const text = '---\ntags: [revisit]\n---\n\nFront: A\nBack: B\n\n---\n\nFront: C\nBack: D\n';
		const [first] = parseCardFile(text);
		if (!first) throw new Error('no card');
		const out = removeCard(text, first);
		expect(out.startsWith('---\ntags: [revisit]\n---')).toBe(true);
		expect(parseCardFile(out).map((c) => c.front)).toEqual(['C']);
	});

	it('não colapsa linhas vazias dentro de fences de outros cartões', () => {
		const text = 'Front: A\nBack: a\n\n---\n\nFront: B\nBack:\n```js\n\n\n\nf()\n```\nType: Question\n';
		const [first] = parseCardFile(text);
		if (!first) throw new Error('no card');
		const out = removeCard(text, first);
		expect(out).toContain('```js\n\n\n\nf()');
	});
});

describe('normalizeTopic', () => {
	it('trims the levels', () => {
		expect(normalizeTopic(' Concursos>TI  >  Árvores ')).toBe('Concursos > TI > Árvores');
	});
	it('reads and writes Reverse', () => {
		const c = parseCardFile('Front: a\nBack: b\nReverse: yes ^labcde')[0];
		expect(c?.reverse).toBe(true);
		expect(serializeCard({ ...(c as NonNullable<typeof c>) })).toContain('Reverse: yes ^labcde');
	});
	it('renames a source link', () => {
		const t = 'Front: a\nBack: b\nSource: [[Work/X/Grade|Grade]] ^labcde\n\n---\n\nSource: [[Outra]]';
		const out = renameSource(t, 'Work/X/Grade.md', 'Work/Y/Nova.md');
		expect(out).toContain('[[Work/Y/Nova|Grade]] ^labcde');
		expect(out).toContain('[[Outra]]');
		expect(renameSource('Source: [[a.pdf#page=3|a, p. 3]]', 'a.pdf', 'b/a.pdf')).toBe('Source: [[b/a.pdf#page=3|a, p. 3]]');
	});

	it('renames links de uma pasta inteira', () => {
		const t = 'Source: [[Pasta Antiga/Grade|Grade]]\nSource: [[Pasta Antiga]]\nSource: [[Outro Lugar/Grade]]';
		const out = renameSourceFolder(t, 'Pasta Antiga', 'Novo Lugar');
		expect(out).toContain('[[Novo Lugar/Grade|Grade]]');
		expect(out).toContain('[[Novo Lugar]]');
		expect(out).toContain('[[Outro Lugar/Grade]]');
		expect(renameSourceFolder('Source: [[P/A.pdf#page=2|p]]', 'P', 'Q')).toBe('Source: [[Q/A.pdf#page=2|p]]');
	});
});

describe('lote numa escrita só', () => {
	it('appendCards junta os blocos em ordem, igual a vários appendCard', () => {
		const one = appendCard(appendCard('Front: A\nBack: a', 'Front: B\nBack: b'), 'Front: C\nBack: c');
		expect(appendCards('Front: A\nBack: a', ['Front: B\nBack: b', 'Front: C\nBack: c'])).toBe(one);
		expect(parseCardFile(appendCards('', ['Front: B\nBack: b', 'Front: C\nBack: c']))).toHaveLength(2);
	});
	it('groupBy mantém a ordem dos destinos e dos itens', () => {
		const g = groupBy(['a1', 'b1', 'a2', 'c1', 'b2'], (x) => x[0] as string);
		expect([...g.keys()]).toEqual(['a', 'b', 'c']);
		expect(g.get('a')).toEqual(['a1', 'a2']);
	});
});

describe('Tags', () => {
	it('lê e grava a linha Tags só quando existe', () => {
		const base = { id: 'lab123', type: 'Question' as const, front: 'f', back: 'v', topics: [], source: '' };
		const text = serializeCard({ ...base, tags: ['important'] });
		expect(text).toContain('Tags: #important');
		expect(parseCardFile(text)[0]?.tags).toEqual(['important']);
		expect(serializeCard(base)).not.toContain('Tags:');
		expect(parseCardFile(serializeCard(base))[0]?.tags).toBeUndefined();
	});
});

describe('label-shaped text', () => {
	it('a back line that reads like a label stays in the back, through a round trip', () => {
		const back = 'Line one\nSource: a book\n```\nType: kept\n```';
		const block = serializeCard({ id: 'labcde', type: 'Question', front: 'f', back, topics: [], source: '[[n]]' });
		const [c] = parseCardFile(block);
		expect(c?.source).toBe('[[n]]');
		expect(c?.type).toBe('Question');
		expect(c?.back).toContain('Source: a book');
		expect(c?.back).toContain('```\nType: kept\n```');
		expect(parseCardFile(serializeCard(c as NonNullable<typeof c>))[0]?.back).toBe(c?.back);
	});
});

it('topicsLabel mostra só o último nível', async () => {
	const { topicsLabel } = await import('../src/cards/format');
	expect(topicsLabel(['Sustento > Perseguição', 'Kubernetes'])).toBe('Perseguição; Kubernetes');
});

describe('retagTopics', () => {
	it('renames a topic and every child under it, keeping the rest of the path', () => {
		expect(retagTopics(['Kubernetes', 'Kubernetes > Workloads'], 'Kubernetes', 'K8s')).toEqual(['K8s', 'K8s > Workloads']);
		expect(retagTopics(['A > B > C'], 'A > B', 'X')).toEqual(['X > C']);
	});
	it('matches without case and dedupes the result', () => {
		expect(retagTopics(['kubernetes > workloads'], 'Kubernetes', 'K8s')).toEqual(['K8s > workloads']);
		expect(retagTopics(['A', 'a'], 'a', 'B')).toEqual(['B']);
	});
	it('an empty new name removes the topic', () => {
		expect(retagTopics(['Kubernetes > Workloads', 'CKA'], 'Kubernetes', '')).toEqual(['CKA']);
	});
	it('leaves unrelated topics alone', () => {
		expect(retagTopics(['Kubernetesx', 'AK > B'], 'Kubernetes', 'K8s')).toEqual(['Kubernetesx', 'AK > B']);
	});
});

describe('rewriteTopics', () => {
	it('rewrites only the cards the pick changes, bottom-up, in one pass', () => {
		const r = rewriteTopics(FILE, (card) => (card.topics.some((t) => t === 'Kubernetes' || t.startsWith('Kubernetes > ')) ? retagTopics(card.topics, 'Kubernetes', 'K8s') : null));
		expect(r.changed).toBe(1);
		const cards = parseCardFile(r.text);
		expect(cards[0]?.topics).toEqual(['K8s > Workloads', 'CKA']);
		expect(cards[1]?.topics).toEqual([]);
		expect(cards[0]?.id).toBe('lk7q2a');
		expect(cards[1]?.id).toBe('lab12c');
	});
	it('a full replacement keeps ids and removes the Topic line when empty', () => {
		const r = rewriteTopics(FILE, (card) => (card.id === 'lk7q2a' ? [] : null));
		expect(r.changed).toBe(1);
		const [a] = parseCardFile(r.text);
		expect(a?.topics).toEqual([]);
		expect(a?.id).toBe('lk7q2a');
		expect(r.text).not.toContain('Topic:');
	});
});

describe('rewriteTopics com vários cartões no mesmo arquivo', () => {
	it('two cards changing at once keep the ids and the untouched block', () => {
		const text = 'Front: A\nBack: a\nTopic: Kubernetes > Workloads\n---\n\nFront: B\nBack: b\nTopic: Kubernetes\n---\n\nFront: C\nBack: c\nTopic: CKA\n';
		const r = rewriteTopics(text, (card) => (card.topics.some((t) => t === 'Kubernetes' || t.startsWith('Kubernetes > ')) ? retagTopics(card.topics, 'Kubernetes', 'K8s') : null));
		expect(r.changed).toBe(2);
		const cards = parseCardFile(r.text);
		expect(cards[0]?.topics).toEqual(['K8s > Workloads']);
		expect(cards[1]?.topics).toEqual(['K8s']);
		expect(cards[2]?.topics).toEqual(['CKA']);
		expect(cards.map((c) => c.id)).toEqual([null, null, null]);
	});
});

describe('retagTopics renomeando para dentro de si mesmo', () => {
	it('A -> A > B nests without duplicating the pre-existing child', () => {
		expect(retagTopics(['A', 'A > B'], 'A', 'A > B')).toEqual(['A > B', 'A > B > B']);
	});
});
