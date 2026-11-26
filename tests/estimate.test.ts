import { describe, expect, it } from 'vitest';
import { estimateMinutes, parseMinutes } from '../src/core/estimate';
import type { RevlogEntry } from '../src/core/types';

const entry = (id: string, seconds: number, t = '2026-11-20T12:00:00.000Z'): RevlogEntry => ({ id, t, grade: 3, seconds, type: 'Question', new: false, extra: false });
/** `n` answers, each of a different card */
const log = (n: number, seconds: number, prefix = 'c') => Array.from({ length: n }, (_, i) => entry(`${prefix}${i}`, seconds));

describe('estimateMinutes', () => {
	it('is null with nothing to review', () => {
		expect(estimateMinutes(0, [])).toBeNull();
	});

	it('uses 10 s and 1.3 without history', () => {
		expect(estimateMinutes(30, [])).toBe(7);
	});

	it('keeps the default seconds under 20 answers', () => {
		// 19 answers: 10 s, and their own repeat factor of 1
		expect(estimateMinutes(60, log(19, 40))).toBe(10);
		expect(estimateMinutes(60, log(20, 40))).toBe(40);
	});

	it('caps a long answer at 60 s', () => {
		expect(estimateMinutes(20, log(20, 3600))).toBe(20);
	});

	it('ignores answers with no time', () => {
		expect(estimateMinutes(60, [...log(20, 20), ...log(50, 0, 'z')])).toBe(20);
	});

	it('looks only at the latest 200 answers', () => {
		expect(estimateMinutes(60, [...log(100, 60, 'old'), ...log(200, 20)])).toBe(20);
	});

	it('counts repeats of the same day, at most 2', () => {
		const twice = [...log(20, 30), ...log(10, 30)];
		expect(estimateMinutes(40, twice)).toBe(30);
		const many = Array.from({ length: 20 }, () => entry('a', 30));
		expect(estimateMinutes(40, many)).toBe(40);
	});

	it('does not count another day as a repeat', () => {
		const days = [...log(10, 30), ...log(10, 30).map((e) => ({ ...e, t: '2026-11-21T12:00:00.000Z' }))];
		expect(estimateMinutes(40, days)).toBe(20);
	});

	it('is at least one minute', () => {
		expect(estimateMinutes(1, [])).toBe(1);
	});
});

describe('parseMinutes', () => {
	it('reads whole minutes from 1 to 180', () => {
		expect(parseMinutes('25')).toBe(25);
		expect(parseMinutes('7.6')).toBe(8);
		expect(parseMinutes('999')).toBe(180);
	});

	it('refuses what is not a length', () => {
		for (const text of ['', ' ', '0', '-5', 'abc']) expect(parseMinutes(text)).toBeNull();
	});
});
