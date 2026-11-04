import { describe, expect, it } from 'vitest';
import { daysLabel, dueNotes, nextInterval, read, untilLabel } from '../src/notes/reread';

const NOW = new Date('2026-11-02T10:00:00');

describe('reread de notas', () => {
	it('começa em 1, 3 ou 7 days e cresce', () => {
		expect(nextInterval(undefined, 'good')).toBe(3);
		const r = read(undefined, 'good', NOW);
		expect(r.times).toBe(1);
		expect(nextInterval(r, 'good')).toBe(8);
		expect(nextInterval(r, 'easy')).toBe(12);
		expect(nextInterval({ ...r, days: 200 }, 'easy')).toBe(365);
	});
	it('marca a próxima leitura à meia-noite do dia', () => {
		const r = read(undefined, 'hard', NOW);
		expect(new Date(r.due).getDate()).toBe(3);
	});
	it('lista as vencidas e limita as novas do dia', () => {
		const old = read(undefined, 'good', new Date('2026-10-20T10:00:00'));
		const todayNew = read(undefined, 'good', new Date('2026-11-02T08:00:00'));
		const notes = [{ path: 'nova1' }, { path: 'vencida', r: old }, { path: 'nova2' }, { path: 'hoje', r: todayNew }];
		expect(dueNotes(notes, NOW, 2)).toEqual(['vencida', 'nova1']);
		expect(dueNotes(notes, NOW, 1)).toEqual(['vencida']);
	});
	it('writes the interval', () => {
		expect(daysLabel(1)).toBe('1 day');
		expect(daysLabel(60)).toBe('2 months');
	});
});

describe('untilLabel', () => {
	const now = new Date('2026-11-02T22:40:00');
	it('counts in calendar days', () => {
		expect(untilLabel(new Date('2026-11-03T07:00:00'), now)).toBe('tomorrow');
		expect(untilLabel(new Date('2026-11-02T23:00:00'), now)).toBe('today');
		expect(untilLabel(new Date('2026-11-09T10:00:00'), now)).toBe('in 7 days');
		expect(untilLabel(new Date('2027-01-05T10:00:00'), now)).toBe('in 2 months');
	});
});
