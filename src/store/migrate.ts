import { escapeLabels, FENCE_RE, idLineFor, splitBlocks } from '../cards/format';
import type { CardType } from '../cards/types';
import type { RevlogEntry } from '../srs/budget';
import type { CardState, Status } from './Store';

/**
 * Migrations of data written in an older, Portuguese format. They recognize it
 * by its labels and keys, so a vault that never had it never goes through here.
 * Before a migration overwrites a file, the original is copied to
 * `<file>.backup-pre-migration` (once).
 */

/** Old Portuguese card types onto the English ones. */
const TYPE_MAP: Record<string, CardType> = { Pergunta: 'Question', Lacuna: 'Cloze', 'Referência': 'Reference', 'Questão': 'Problem' };

const LABEL_MAP: Record<string, string> = { Frente: 'Front', Verso: 'Back', Tipo: 'Type', Assunto: 'Topic', Reverso: 'Reverse', Fonte: 'Source' };
const LEGACY_LABEL_RE = /^(Frente|Verso|Tipo|Área|Assunto|Reverso|Fonte):[ \t]?(.*)$/;
const ANY_LABEL_RE = /^(Frente|Verso|Tipo|Área|Assunto|Reverso|Fonte|Front|Back|Type|Topic|Reverse|Source):/;
const TAGS_RE = /^Tags:/;
const TRAILING_ID_RE = /\s\^(l[a-z0-9]{5})\s*$/;

/** A card block in the old format: its first label is an old one and it has a `Frente:`. */
function isLegacyBlock(lines: string[]): boolean {
	let fence = false;
	let first: string | null = null;
	let front = false;
	for (const line of lines) {
		if (!fence) {
			const m = ANY_LABEL_RE.exec(line);
			if (m) {
				first ??= m[1] as string;
				if (m[1] === 'Frente') front = true;
			}
		}
		if (FENCE_RE.test(line)) fence = !fence;
	}
	return !!first && first in LABEL_MAP && front;
}

/** One old label line in the new format, keeping the block id at its end. */
function migrateLabelLine(label: string, rest: string): string {
	const idMatch = TRAILING_ID_RE.exec(rest);
	const value = idMatch ? rest.slice(0, idMatch.index) : rest;
	const id = idMatch ? ` ^${idMatch[1] as string}` : '';
	if (label === 'Tipo') return `Type: ${TYPE_MAP[value.trim()] ?? value.trim()}${id}`;
	if (label === 'Reverso') return `Reverse: ${/^(sim|s|yes|true)$/i.test(value.trim()) ? 'yes' : 'no'}${id}`;
	return `${LABEL_MAP[label] as string}:${value ? ` ${value}` : ''}${id}`;
}

function migrateBlock(lines: string[]): string[] {
	const out: string[] = [];
	/** indexes in `out` of the text lines that may read like a new label */
	const body: number[] = [];
	let fence = false;
	let dropping = false;
	let lostId: string | null = null;
	for (const line of lines) {
		const m = fence ? null : LEGACY_LABEL_RE.exec(line);
		if (m) dropping = false;
		if (m?.[1] === 'Área') {
			// the area is gone, with any line it ran over; an id at its end moves up
			dropping = true;
			lostId = TRAILING_ID_RE.exec(m[2] ?? '')?.[1] ?? lostId;
		} else if (m) {
			out.push(migrateLabelLine(m[1] as string, m[2] ?? ''));
		} else if (!fence && TAGS_RE.test(line)) {
			dropping = false;
			out.push(line.replace(/#importante\b/gi, '#important'));
		} else if (!dropping || (!fence && line.trim() === '')) {
			if (!fence) body.push(out.length);
			out.push(line);
		}
		if (FENCE_RE.test(line)) fence = !fence;
	}
	for (const i of body) {
		// a line of text inside a code fence never reaches here, so the fence state does not matter
		out[i] = escapeLabels([out[i] as string])[0] as string;
	}
	if (lostId) {
		const at = idLineFor(out, 0, out.length - 1);
		if (at >= 0) out[at] = `${(out[at] as string).replace(/\s+$/, '')} ^${lostId}`;
	}
	return out;
}

/** A card file in the English format. Only old blocks change, so running it again changes nothing. */
export function migrateCardText(text: string): { text: string; changed: boolean } {
	if (!text.includes('Frente:')) return { text, changed: false };
	const lines = text.split('\n');
	let changed = false;
	for (const block of splitBlocks(text).reverse()) {
		if (!isLegacyBlock(block.lines)) continue;
		lines.splice(block.start, block.end - block.start + 1, ...migrateBlock(block.lines));
		changed = true;
	}
	return changed ? { text: lines.join('\n'), changed } : { text, changed };
}

export interface MigrationIO {
	read: (path: string) => Promise<string>;
	exists: (path: string) => Promise<boolean>;
	write: (path: string, text: string) => Promise<void>;
}

/** Moves card files to the English format; the original of each goes to `<file>.backup-pre-migration` first. Returns how many changed. */
export async function migrateCardFiles(paths: string[], io: MigrationIO): Promise<number> {
	let done = 0;
	for (const path of paths) {
		const text = await io.read(path);
		const migrated = migrateCardText(text);
		if (!migrated.changed) continue;
		const backup = `${path}.backup-pre-migration`;
		if (!(await io.exists(backup))) await io.write(backup, text);
		await io.write(path, migrated.text);
		done++;
	}
	return done;
}

/** The data files Revisit keeps in its folder. */
export const DATA_FILES = { state: 'state.json', stateBackup: 'state.backup.json', log: 'review-log.jsonl' } as const;

/** Names the same files had in older versions, and what each became. */
const LEGACY_DATA_FILES: readonly (readonly [old: string, now: string])[] = [
	['estado.json', DATA_FILES.state],
	['estado.backup.json', DATA_FILES.stateBackup],
	['revisoes.jsonl', DATA_FILES.log],
];

export interface DataFilesIO extends Pick<MigrationIO, 'read' | 'exists' | 'write'> {
	rename: (from: string, to: string) => Promise<void>;
}

/**
 * Moves the data files of older versions to their current names, inside `base`.
 * Safe to run on every start: a file moves only when the new name is absent;
 * the old one is kept beside it as `<old>.backup-pre-migration` (a number is
 * added when that name is taken); when both exist nothing is touched. The new
 * file is written under a temporary name and renamed, so a crash halfway leaves
 * the old file in place and the next start does it again. Returns the old names moved.
 */
export async function migrateDataFiles(base: string, io: DataFilesIO): Promise<string[]> {
	const moved: string[] = [];
	for (const [old, now] of LEGACY_DATA_FILES) {
		const from = `${base}/${old}`;
		const to = `${base}/${now}`;
		if (!(await io.exists(from)) || (await io.exists(to))) continue;
		const tmp = `${to}.migrating`;
		await io.write(tmp, await io.read(from));
		await io.rename(tmp, to);
		let backup = `${from}.backup-pre-migration`;
		for (let n = 1; await io.exists(backup); n++) backup = `${from}.backup-pre-migration.${n}`;
		await io.rename(from, backup);
		moved.push(old);
	}
	return moved;
}

/** Old Portuguese suspension values onto the English ones. */
const STATUS_MAP: Record<string, Status> = { ativo: 'active', suspenso: 'suspended' };

/** Moves the reread schedule fields (`dias`/`lida`/`vezes`) to English, whatever the wrapper key is. */
function migrateRereadFields(r: Record<string, unknown>): boolean {
	let changed = false;
	if ('dias' in r) {
		r.days = r.dias;
		delete r.dias;
		changed = true;
	}
	if ('lida' in r) {
		r.lastRead = r.lida;
		delete r.lida;
		changed = true;
	}
	if ('vezes' in r) {
		r.times = r.vezes;
		delete r.vezes;
		changed = true;
	}
	return changed;
}

/**
 * The state file (`estado.json` in old versions): keys `nota:<path>` become `note:<path>`, `st: 'ativo'|'suspenso'`
 * becomes `'active'|'suspended'` and the `releitura` schedule becomes `reread`
 * with English fields. English input passes through unchanged; `changed` says
 * whether anything was rewritten, so the caller only backs up and persists when
 * the file was really in the old schema.
 */
export function migrateEstado(raw: Record<string, unknown>): { state: Record<string, CardState>; changed: boolean } {
	const state: Record<string, CardState> = {};
	let changed = false;
	for (const [key, value] of Object.entries(raw)) {
		let k = key;
		if (k.startsWith('nota:')) {
			k = `note:${k.slice(5)}`;
			changed = true;
		}
		if (!value || typeof value !== 'object' || Array.isArray(value)) {
			state[k] = value as CardState;
			continue;
		}
		const v = { ...(value as Record<string, unknown>) };
		if (typeof v.st === 'string' && STATUS_MAP[v.st]) {
			v.st = STATUS_MAP[v.st];
			changed = true;
		}
		if ('releitura' in v) {
			v.reread = v.releitura;
			delete v.releitura;
			changed = true;
		}
		if (v.reread && typeof v.reread === 'object' && !Array.isArray(v.reread)) {
			if (migrateRereadFields(v.reread as Record<string, unknown>)) changed = true;
		}
		state[k] = v as unknown as CardState;
	}
	return { state, changed };
}

/**
 * data.json (settings): the per-group new-card quotas (`newPerArea`, `cota:<name>`)
 * add up to the one daily quota `newPerDay`; `areaMap` and the last topics saved
 * per group go away.
 */
export function migrateSettings(raw: Record<string, unknown> | null | undefined): { settings: Record<string, unknown>; changed: boolean } {
	const settings: Record<string, unknown> = { ...(raw ?? {}) };
	let changed = false;
	const drop = (key: string) => {
		delete settings[key];
		changed = true;
	};
	const quotas: unknown[] = [];
	for (const key of Object.keys(settings)) {
		if (!key.startsWith('cota:')) continue;
		quotas.push(settings[key]);
		drop(key);
	}
	if (settings.newPerArea && typeof settings.newPerArea === 'object') quotas.push(...Object.values(settings.newPerArea as Record<string, unknown>));
	if ('newPerArea' in settings) drop('newPerArea');
	if (quotas.length || changed) {
		const sum = quotas.reduce<number>((s, q) => s + (Number(q) || 0), 0);
		if (sum > 0) settings.newPerDay = sum;
		else delete settings.newPerDay;
	}
	if ('areaMap' in settings) drop('areaMap');
	if ('lastAssunto' in settings) drop('lastAssunto');
	const last = settings.lastTopic;
	if (last && typeof last === 'object' && '__area' in last) drop('lastTopic');
	return { settings, changed };
}

/**
 * One line of the review log (`revisoes.jsonl` in old versions): accepts the old Portuguese field names
 * (`nota`, `segundos`, `tipo`, `novo`, `estado`) and card types beside the
 * English ones forever, so the file itself is never rewritten.
 */
export function migrateLogEntry(raw: unknown): RevlogEntry {
	const e = (raw ?? {}) as Record<string, unknown>;
	const str = (x: unknown): string => (typeof x === 'string' ? x : '');
	const out: RevlogEntry = {
		id: str(e.id),
		t: str(e.t),
		grade: Number(e.grade ?? e.nota ?? 0),
		seconds: Number(e.seconds ?? e.segundos ?? 0),
		type: TYPE_MAP[str(e.type ?? e.tipo)] ?? ((e.type ?? e.tipo) as CardType),
		new: Boolean(e.new ?? e.novo),
		extra: Boolean(e.extra),
	};
	const state = e.state ?? e.estado;
	if (state !== undefined) out.state = Number(state);
	return out;
}
