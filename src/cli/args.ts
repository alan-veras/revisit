import { parseCardFile } from '../cards/format';
import { Card } from '../cards/types';
import { CardStatus } from '../srs/rows';

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
	if (v === undefined || v === '' || v === 'true') throw new CliError('parameter', `missing ${key}=`);
	return v;
}

export function flag(p: Params, key: string): boolean {
	const v = p[key];
	return v === 'true' || v === '1' || v === 'sim' || v === 'yes';
}

/** The `estado` flag keeps its old Portuguese values working beside the new English ones. */
export const STATUS_ALIASES: Record<string, CardStatus> = { novo: 'new', aprendendo: 'learning', revisao: 'review', suspenso: 'suspended' };

/** Reads the `estado` flag: the English values pass through, the old Portuguese ones map onto them, anything else matches nothing. */
export function statusFilter(p: Params): string | undefined {
	const v = p.estado?.toLowerCase();
	if (!v) return undefined;
	return STATUS_ALIASES[v] ?? v;
}

/** The old Portuguese command names, kept as exact aliases: nobody using them today may break. */
export const PT_ALIASES: Record<string, string> = {
	hoje: 'today',
	cartoes: 'cards',
	ver: 'show',
	novo: 'new',
	lote: 'batch',
	editar: 'edit',
	suspender: 'suspend',
	revisar: 'review',
};

/** `\n` typed in a flag value becomes a line break (an agent cannot pass one otherwise). */
export function unescape(v: string): string {
	return v.replace(/\\n/g, '\n');
}

/** Cards of a batch file, written in the card format; every one must have front and back. */
export function parseBatch(text: string): Omit<Card, 'start' | 'end'>[] {
	const cards = parseCardFile(text);
	if (!cards.length) throw new CliError('batch', 'no cards in the file (Frente:/Verso: blocks separated by ---)');
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
