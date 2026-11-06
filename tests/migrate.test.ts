import { describe, expect, it } from 'vitest';
import { parseCardFile } from '../src/cards/format';
import { MigrationIO, migrateCardFiles, migrateCardText, migrateDataFiles, migrateEstado, migrateLogEntry, migrateSettings } from '../src/store/migrate';
import { parseLogLines } from '../src/store/parse';

const OLD = `---
tags: [cards]
---

Frente: Como desfazer o último rollout?
Verso:
\`\`\`yaml
Frente: dentro da cerca
Fonte: dentro da cerca
---
\`\`\`
Depois \`--to-revision=2\`.
Source: linha de texto que parece rótulo novo
Tipo: Pergunta
Assunto: Kubernetes > Workloads; CKA
Tags: #importante #exam
Reverso: sim
Fonte: [[Work/CKA|CKA]] ^lk7q2a

---

Frente: A ==fé== é a ==certeza==
Verso:
Tipo: Lacuna
Área: Trabalho ^lab12c

---

Frente: Isaías 45:22
Verso: Voltem-se para mim
Tipo: Referência
Área: Trabalho
Assunto: Sustento > Desespero
Fonte: [[Books/Isa 45|Isa 45]] ^lg6nab

---

Frente: Enunciado
Verso: Certa
Tipo: Questão
Reverso: não
Fonte: [[Prova.pdf#page=3|Prova, p. 3]] ^lq1234
`;

describe('migrateCardText', () => {
	const { text, changed } = migrateCardText(OLD);
	const cards = parseCardFile(text);
	it('reads every card with its id, in order', () => {
		expect(changed).toBe(true);
		expect(cards.map((c) => c.id)).toEqual(['lk7q2a', 'lab12c', 'lg6nab', 'lq1234']);
		expect(cards.map((c) => c.type)).toEqual(['Question', 'Cloze', 'Reference', 'Problem']);
	});
	it('keeps each field', () => {
		const [a, b, c, d] = cards;
		expect(a?.topics).toEqual(['Kubernetes > Workloads', 'CKA']);
		expect(a?.tags).toEqual(['important', 'exam']);
		expect(a?.reverse).toBe(true);
		expect(a?.source).toBe('[[Work/CKA|CKA]]');
		expect(b?.front).toBe('A ==fé== é a ==certeza==');
		expect(c?.back).toBe('Voltem-se para mim');
		expect(c?.topics).toEqual(['Sustento > Desespero']);
		expect(d?.reverse).toBeUndefined();
		expect(d?.source).toBe('[[Prova.pdf#page=3|Prova, p. 3]]');
	});
	it('leaves code fences and the frontmatter intact', () => {
		expect(text.startsWith('---\ntags: [cards]\n---\n')).toBe(true);
		expect(text).toContain('```yaml\nFrente: dentro da cerca\nFonte: dentro da cerca\n---\n```');
		expect(cards[0]?.back).toContain('Frente: dentro da cerca');
	});
	it('a text line shaped like a new label stays in the back', () => {
		expect(cards[0]?.back).toContain('Source: linha de texto que parece rótulo novo');
		expect(cards[0]?.source).toBe('[[Work/CKA|CKA]]');
	});
	it('drops the area and leaves no old label outside the fences', () => {
		expect(text).not.toMatch(/^(Área|Verso|Tipo|Assunto|Reverso):/m);
		expect(text.replace(/```[\s\S]*?```/g, '')).not.toMatch(/^(Frente|Fonte):/m);
	});
	it('moves an id that sat on the area line', () => {
		expect(text).toContain('Type: Cloze ^lab12c');
	});
	it('is idempotent', () => {
		expect(migrateCardText(text)).toEqual({ text, changed: false });
	});
	it('leaves English cards alone, even with Portuguese text in the back', () => {
		const en = 'Front: a\nBack:\nFrente: de um livro\nFonte: outro\nType: Question ^labcde\n';
		expect(migrateCardText(en)).toEqual({ text: en, changed: false });
	});
	it('migrates only the old blocks of a mixed file', () => {
		const mixed = 'Front: a\nBack: b ^laaaaa\n\n---\n\nFrente: c\nVerso: d ^lbbbbb\n';
		const out = migrateCardText(mixed).text;
		expect(parseCardFile(out).map((c) => c.id)).toEqual(['laaaaa', 'lbbbbb']);
	});
	it('leaves prose with a loose label alone', () => {
		const prose = 'Fonte: um livro\n\nMais texto.\n';
		expect(migrateCardText(prose)).toEqual({ text: prose, changed: false });
	});
});

describe('migrateCardFiles', () => {
	const memory = (files: Record<string, string>): MigrationIO & { files: Record<string, string> } => ({
		files,
		read: async (p) => files[p] as string,
		exists: async (p) => p in files,
		write: async (p, t) => {
			files[p] = t;
		},
	});
	it('copies the original before writing, once, and skips what is done', async () => {
		const io = memory({ 'R/a.md': OLD, 'R/b.md': 'Front: x\nBack: y ^lxxxxx\n' });
		expect(await migrateCardFiles(['R/a.md', 'R/b.md'], io)).toBe(1);
		expect(io.files['R/a.md.backup-pre-migration']).toBe(OLD);
		expect('R/b.md.backup-pre-migration' in io.files).toBe(false);
		expect(io.files['R/a.md']).toContain('Front: Isaías 45:22');
		const after = io.files['R/a.md'];
		expect(await migrateCardFiles(['R/a.md', 'R/b.md'], io)).toBe(0);
		expect(io.files['R/a.md']).toBe(after);
		expect(io.files['R/a.md.backup-pre-migration']).toBe(OLD);
	});
	it('an existing backup is never overwritten', async () => {
		const io = memory({ 'R/a.md': OLD, 'R/a.md.backup-pre-migration': 'first' });
		await migrateCardFiles(['R/a.md'], io);
		expect(io.files['R/a.md.backup-pre-migration']).toBe('first');
	});
	it('the backup comes before the write', async () => {
		const order: string[] = [];
		const io = memory({ 'R/a.md': OLD });
		const write = io.write;
		io.write = async (p, t) => {
			order.push(p);
			await write(p, t);
		};
		await migrateCardFiles(['R/a.md'], io);
		expect(order).toEqual(['R/a.md.backup-pre-migration', 'R/a.md']);
	});
});

describe('migrateEstado (estado.json)', () => {
	it('rewrites the old schema: nota: keys, ativo/suspenso, releitura fields', () => {
		const raw = JSON.parse('{"labcde":{"st":"ativo","fsrs":{"due":"2026-11-01T00:00:00Z","state":2}},"nota:/Notas/X.md":{"st":"ativo","releitura":{"due":"2026-11-10T00:00:00Z","dias":3,"lida":"2026-11-07T08:00:00Z","vezes":2}},"nota:/Notas/Y.md":{"st":"suspenso"}}') as Record<string, unknown>;
		const { state, changed } = migrateEstado(raw);
		expect(changed).toBe(true);
		expect(Object.keys(state).sort()).toEqual(['labcde', 'note:/Notas/X.md', 'note:/Notas/Y.md']);
		expect(state['labcde']?.st).toBe('active');
		expect(state['note:/Notas/Y.md']?.st).toBe('suspended');
		const reread = state['note:/Notas/X.md']?.reread;
		expect(reread).toEqual({ due: '2026-11-10T00:00:00Z', days: 3, lastRead: '2026-11-07T08:00:00Z', times: 2 });
		expect('releitura' in (state['note:/Notas/X.md'] as object)).toBe(false);
		expect(state['labcde']?.fsrs).toEqual({ due: '2026-11-01T00:00:00Z', state: 2 });
	});
	it('a file already in English passes through unchanged', () => {
		const raw = { labcde: { st: 'active', reread: { due: 'd', days: 1, lastRead: 'r', times: 1 } }, 'note:/x.md': { st: 'suspended' } };
		const { state, changed } = migrateEstado(raw);
		expect(changed).toBe(false);
		expect(state).toEqual(raw);
	});
	it('is idempotent: migrating twice changes nothing the second time', () => {
		const raw = JSON.parse('{"nota:/x.md":{"st":"ativo","releitura":{"dias":3,"lida":"r","vezes":1,"due":"d"}}}') as Record<string, unknown>;
		const first = migrateEstado(raw);
		expect(first.changed).toBe(true);
		const second = migrateEstado(first.state);
		expect(second.changed).toBe(false);
		expect(second.state).toEqual(first.state);
	});
	it('odd values pass through untouched', () => {
		const { state, changed } = migrateEstado({ lixo: 'texto', vazio: null, lista: [1] });
		expect(changed).toBe(false);
		expect(state.lixo).toBe('texto');
		expect(state.vazio).toBeNull();
		expect(state.lista).toEqual([1]);
	});
});

describe('migrateSettings (data.json)', () => {
	it('adds the group quotas into one daily quota and drops the group settings', () => {
		const raw = { lastAssunto: { Work: 'K8s', __area: 'Work' }, 'cota:Faith': 7, 'cota:Fun': 0, newPerArea: { Work: 3 }, newPerDay: 99, areaMap: { x: 'y' }, budgetMinutes: 15 };
		const { settings, changed } = migrateSettings(raw);
		expect(changed).toBe(true);
		expect(settings).toEqual({ newPerDay: 10, budgetMinutes: 15 });
	});
	it('empty group quotas leave the default in charge', () => {
		expect(migrateSettings({ newPerArea: {}, folder: 'Cards' })).toEqual({ settings: { folder: 'Cards' }, changed: true });
	});
	it('last topics saved per group go away, the ones per folder stay', () => {
		expect(migrateSettings({ lastTopic: { Work: 'K8s', __area: 'Work' } }).settings).toEqual({});
		const raw = { lastTopic: { 'Notes/Bio': 'Cells' }, newPerDay: 8, budgetMinutes: 15 };
		expect(migrateSettings(raw)).toEqual({ settings: raw, changed: false });
	});
	it('null or empty loads stay unchanged', () => {
		expect(migrateSettings(null)).toEqual({ settings: {}, changed: false });
		expect(migrateSettings(undefined)).toEqual({ settings: {}, changed: false });
	});
	it('is idempotent', () => {
		const first = migrateSettings({ newPerArea: { Work: 3 }, areaMap: {} });
		expect(migrateSettings(first.settings)).toEqual({ settings: first.settings, changed: false });
	});
});

describe('migrateLogEntry (revisoes.jsonl)', () => {
	it('reads an old Portuguese line into the English entry, type included', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"labcde","t":"2026-11-03T10:00:00Z","nota":2,"segundos":42,"tipo":"Questão","novo":true,"extra":false,"estado":1}'));
		expect(e).toEqual({ id: 'labcde', t: '2026-11-03T10:00:00Z', grade: 2, seconds: 42, type: 'Problem', new: true, extra: false, state: 1 });
	});
	it('reads a new English line as is', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"labfgh","t":"2026-11-04T10:00:00Z","grade":3,"seconds":10,"type":"Question","new":false,"extra":false}'));
		expect(e).toEqual({ id: 'labfgh', t: '2026-11-04T10:00:00Z', grade: 3, seconds: 10, type: 'Question', new: false, extra: false });
	});
	it('a line without the optional state stays without it', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"x","t":"t","nota":1,"segundos":1,"tipo":"Lacuna","novo":true,"extra":true}'));
		expect('state' in e).toBe(false);
	});
});

describe('migrateDataFiles (data files renamed)', () => {
	/** an in-memory folder that behaves like the vault adapter */
	function folder(files: Record<string, string>) {
		const fs = { ...files };
		const io = {
			read: async (p: string) => fs[p] as string,
			exists: async (p: string) => p in fs,
			write: async (p: string, t: string) => void (fs[p] = t),
			rename: async (a: string, b: string) => {
				fs[b] = fs[a] as string;
				delete fs[a];
			},
		};
		return { fs, io };
	}
	const OLD = { 'R/estado.json': '{"a":1}', 'R/estado.backup.json': '{"a":0}', 'R/revisoes.jsonl': '{"id":"a"}\n{"id":"b"}\n' };

	it('copies to the new names and keeps the old files as backups', async () => {
		const { fs, io } = folder(OLD);
		expect(await migrateDataFiles('R', io)).toEqual(['estado.json', 'estado.backup.json', 'revisoes.jsonl']);
		expect(fs['R/state.json']).toBe('{"a":1}');
		expect(fs['R/state.backup.json']).toBe('{"a":0}');
		expect(fs['R/review-log.jsonl']).toBe('{"id":"a"}\n{"id":"b"}\n');
		expect(fs['R/estado.json.backup-pre-migration']).toBe('{"a":1}');
		expect(fs['R/revisoes.jsonl.backup-pre-migration']).toBe('{"id":"a"}\n{"id":"b"}\n');
		expect(Object.keys(fs).some((k) => k.endsWith('.migrating'))).toBe(false);
		expect('R/estado.json' in fs).toBe(false);
	});

	it('is idempotent: a second run changes nothing', async () => {
		const { fs, io } = folder(OLD);
		await migrateDataFiles('R', io);
		const snapshot = { ...fs };
		expect(await migrateDataFiles('R', io)).toEqual([]);
		expect(fs).toEqual(snapshot);
	});

	it('never overwrites a file that already has the new name', async () => {
		const { fs, io } = folder({ ...OLD, 'R/state.json': '{"new":true}' });
		expect(await migrateDataFiles('R', io)).toEqual(['estado.backup.json', 'revisoes.jsonl']);
		expect(fs['R/state.json']).toBe('{"new":true}');
		expect(fs['R/estado.json']).toBe('{"a":1}');
	});

	it('keeps an existing backup and numbers the next one', async () => {
		const { fs, io } = folder({ 'R/estado.json': '{"a":1}', 'R/estado.json.backup-pre-migration': 'older' });
		await migrateDataFiles('R', io);
		expect(fs['R/estado.json.backup-pre-migration']).toBe('older');
		expect(fs['R/estado.json.backup-pre-migration.1']).toBe('{"a":1}');
	});

	it('does nothing in a vault with no old files', async () => {
		const { fs, io } = folder({ 'R/state.json': '{}' });
		expect(await migrateDataFiles('R', io)).toEqual([]);
		expect(fs).toEqual({ 'R/state.json': '{}' });
	});

	it('recovers from a crash after the temporary write', async () => {
		const { fs, io } = folder({ ...OLD, 'R/state.json.migrating': 'half' });
		await migrateDataFiles('R', io);
		expect(fs['R/state.json']).toBe('{"a":1}');
	});

	it('the migrated log is still read, old Portuguese lines included', () => {
		const text = '{"id":"labcde","t":"2026-11-03T10:00:00Z","nota":2,"segundos":42,"tipo":"Questão","novo":true,"extra":false}\n{"id":"labcde","t":"2026-11-04T10:00:00Z","grade":3,"seconds":9,"type":"Question","new":false,"extra":false}\n';
		const { entries, bad } = parseLogLines(text);
		expect(bad).toBe(0);
		expect(entries.map((e) => [e.grade, e.type, e.seconds])).toEqual([[2, 'Problem', 42], [3, 'Question', 9]]);
	});
});
