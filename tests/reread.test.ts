import { describe, expect, it } from 'vitest';
import { daysLabel, dueNotes, nextInterval, read } from '../src/notes/reread';

const NOW = new Date('2026-11-02T10:00:00');

describe('releitura de notas', () => {
	it('começa em 1, 3 ou 7 dias e cresce', () => {
		expect(nextInterval(undefined, 'bom')).toBe(3);
		const r = read(undefined, 'bom', NOW);
		expect(r.vezes).toBe(1);
		expect(nextInterval(r, 'bom')).toBe(8);
		expect(nextInterval(r, 'facil')).toBe(12);
		expect(nextInterval({ ...r, dias: 200 }, 'facil')).toBe(365);
	});
	it('marca a próxima leitura à meia-noite do dia', () => {
		const r = read(undefined, 'dificil', NOW);
		expect(new Date(r.due).getDate()).toBe(3);
	});
	it('lista as vencidas e limita as novas do dia', () => {
		const old = read(undefined, 'bom', new Date('2026-10-20T10:00:00'));
		const todayNew = read(undefined, 'bom', new Date('2026-11-02T08:00:00'));
		const notes = [{ path: 'nova1' }, { path: 'vencida', r: old }, { path: 'nova2' }, { path: 'hoje', r: todayNew }];
		expect(dueNotes(notes, NOW, 2)).toEqual(['vencida', 'nova1']);
		expect(dueNotes(notes, NOW, 1)).toEqual(['vencida']);
	});
	it('escreve o intervalo', () => {
		expect(daysLabel(1)).toBe('1 dia');
		expect(daysLabel(60)).toBe('2 meses');
	});
});
