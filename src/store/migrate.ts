import type { RevlogEntry } from '../srs/budget';
import type { CardType } from '../cards/types';
import type { CardState, Status } from './Store';

/**
 * Migrations of the plugin's private storage. The reader accepts the old
 * Portuguese schemas forever; the writer only produces the English ones.
 * Before the first migration overwrites a file, the caller copies the original
 * to `<file>.backup-pre-migration` (once).
 */

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
 * estado.json: keys `nota:<path>` become `note:<path>`, `st: 'ativo'|'suspenso'`
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
 * data.json (settings): the old `lastAssunto` key becomes `lastTopic`, legacy
 * `cota:<Area>` keys move into `newPerArea`, and the long-gone general cap
 * `newPerDay` is dropped. Area names stay Portuguese: they are vault data.
 */
export function migrateSettings(raw: Record<string, unknown> | null | undefined): { settings: Record<string, unknown>; changed: boolean } {
	const settings: Record<string, unknown> = { ...(raw ?? {}) };
	let changed = false;
	if ('lastAssunto' in settings) {
		settings.lastTopic = settings.lastAssunto;
		delete settings.lastAssunto;
		changed = true;
	}
	for (const key of Object.keys(settings)) {
		if (key.startsWith('cota:')) {
			const perArea = (settings.newPerArea && typeof settings.newPerArea === 'object' ? { ...(settings.newPerArea as Record<string, unknown>) } : {}) as Record<string, unknown>;
			perArea[key.slice('cota:'.length)] = settings[key];
			settings.newPerArea = perArea;
			delete settings[key];
			changed = true;
		}
	}
	if ('newPerDay' in settings) {
		delete settings.newPerDay;
		changed = true;
	}
	return { settings, changed };
}

/**
 * One revisoes.jsonl line: accepts the old Portuguese field names
 * (`nota`, `segundos`, `tipo`, `novo`, `estado`) and the English ones forever;
 * the type values stay Portuguese (they are the card types of the notes).
 */
export function migrateLogEntry(raw: unknown): RevlogEntry {
	const e = (raw ?? {}) as Record<string, unknown>;
	const str = (x: unknown): string => (typeof x === 'string' ? x : '');
	const out: RevlogEntry = {
		id: str(e.id),
		t: str(e.t),
		grade: Number(e.grade ?? e.nota ?? 0),
		seconds: Number(e.seconds ?? e.segundos ?? 0),
		type: (e.type ?? e.tipo) as CardType,
		new: Boolean(e.new ?? e.novo),
		extra: Boolean(e.extra),
	};
	const state = e.state ?? e.estado;
	if (state !== undefined) out.state = Number(state);
	return out;
}
