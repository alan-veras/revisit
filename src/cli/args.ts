import { parseCardFile } from '../cards/format';
import { Card } from '../cards/types';

/** Pure helpers of the `revisit:` commands; nothing here touches Obsidian. */

export class CliError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message);
	}
}

export type Params = Record<string, string>;

export function need(p: Params, key: string): string {
	const v = p[key];
	if (v === undefined || v === '' || v === 'true') throw new CliError('parametro', `falta ${key}=`);
	return v;
}

export function flag(p: Params, key: string): boolean {
	const v = p[key];
	return v === 'true' || v === '1' || v === 'sim';
}

/** `\n` typed in a flag value becomes a line break (an agent cannot pass one otherwise). */
export function unescape(v: string): string {
	return v.replace(/\\n/g, '\n');
}

/** Cards of a batch file, written in the card format; every one must have front and back. */
export function parseLote(text: string): Omit<Card, 'start' | 'end'>[] {
	const cards = parseCardFile(text);
	if (!cards.length) throw new CliError('lote', 'nenhum cartão no arquivo (blocos Frente:/Verso: separados por ---)');
	return cards.map(({ start: _s, end: _e, ...c }) => ({ ...c, id: null }));
}

/** Front shortened to one line, for listings. */
export function short(text: string, max = 80): string {
	const one = text.replace(/\s+/g, ' ').trim();
	return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

export function json(value: unknown): string {
	return JSON.stringify(value);
}
