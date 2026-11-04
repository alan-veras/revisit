import { describe, expect, it } from 'vitest';
import { migrateEstado, migrateLogEntry, migrateSettings } from '../src/store/migrate';

describe('migrateEstado (estado.json)', () => {
	it('rewrites the old Portuguese schema: nota: keys, ativo/suspenso, releitura fields', () => {
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
	it('renames lastAssunto to lastTopic, moves legacy cota:<Area> keys into newPerArea and drops newPerDay', () => {
		const raw = { lastAssunto: { Carreira: 'Kubernetes', __area: 'Carreira' }, 'cota:Espiritual': 7, 'cota:Lazer': 0, newPerDay: 20, budgetMinutes: 15 };
		const { settings, changed } = migrateSettings(raw);
		expect(changed).toBe(true);
		expect(settings.lastTopic).toEqual({ Carreira: 'Kubernetes', __area: 'Carreira' });
		expect('lastAssunto' in settings).toBe(false);
		expect(settings.newPerArea).toEqual({ Espiritual: 7, Lazer: 0 });
		expect('newPerDay' in settings).toBe(false);
		expect(settings.budgetMinutes).toBe(15);
	});
	it('an English data.json passes through unchanged', () => {
		const raw = { lastTopic: { Carreira: 'K8s' }, newPerArea: { Lazer: 2 }, budgetMinutes: 15 };
		const { settings, changed } = migrateSettings(raw);
		expect(changed).toBe(false);
		expect(settings).toEqual(raw);
	});
	it('null or empty loads stay unchanged', () => {
		expect(migrateSettings(null)).toEqual({ settings: {}, changed: false });
		expect(migrateSettings(undefined)).toEqual({ settings: {}, changed: false });
	});
	it('area names stay Portuguese: they are vault data, not schema', () => {
		const raw = { newPerArea: { Espiritual: 3, 'Desenvolvimento Pessoal': 4 } };
		const { settings, changed } = migrateSettings(raw);
		expect(changed).toBe(false);
		expect(settings.newPerArea).toEqual({ Espiritual: 3, 'Desenvolvimento Pessoal': 4 });
	});
});

describe('migrateLogEntry (revisoes.jsonl)', () => {
	it('reads an old Portuguese line into the English entry', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"labcde","t":"2026-11-03T10:00:00Z","nota":2,"segundos":42,"tipo":"Questão","novo":true,"extra":false,"estado":1}'));
		expect(e).toEqual({ id: 'labcde', t: '2026-11-03T10:00:00Z', grade: 2, seconds: 42, type: 'Questão', new: true, extra: false, state: 1 });
	});
	it('reads a new English line as is, and the type value stays Portuguese', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"labfgh","t":"2026-11-04T10:00:00Z","grade":3,"seconds":10,"type":"Pergunta","new":false,"extra":false}'));
		expect(e).toEqual({ id: 'labfgh', t: '2026-11-04T10:00:00Z', grade: 3, seconds: 10, type: 'Pergunta', new: false, extra: false });
	});
	it('a line without the optional state stays without it', () => {
		const e = migrateLogEntry(JSON.parse('{"id":"x","t":"t","nota":1,"segundos":1,"tipo":"Lacuna","novo":true,"extra":true}'));
		expect('state' in e).toBe(false);
	});
});
