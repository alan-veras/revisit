import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCardFile, splitBlocks } from '../src/cards/format';
import { migrateCardFiles } from '../src/store/migrate';

/**
 * Regression on a real card folder: `REVISIT_FIXTURE=/path npm test`. Nothing is
 * written there, the files live in memory. Without the variable it is skipped:
 * real cards do not belong in the repo.
 */
const dir = process.env.REVISIT_FIXTURE;

function cardFiles(root: string): string[] {
	return readdirSync(root, { withFileTypes: true, recursive: true })
		.filter((e) => e.isFile() && e.name.endsWith('.md'))
		.map((e) => join(e.parentPath, e.name));
}

/** Ids at the end of the lines, read straight from the text, no parser involved. */
const rawIds = (text: string) => splitBlocks(text).flatMap((b) => b.lines.flatMap((l) => /\s\^(l[a-z0-9]{5})\s*$/.exec(l)?.[1] ?? []));

describe.skipIf(!dir || !existsSync(dir))('migration of a real card folder', () => {
	const paths = dir ? cardFiles(dir) : [];
	const files: Record<string, string> = Object.fromEntries(paths.map((p) => [p, readFileSync(p, 'utf8')]));
	const before = paths.flatMap((p) => rawIds(files[p] as string));
	const io = {
		read: async (p: string) => files[p] as string,
		exists: async (p: string) => p in files,
		write: async (p: string, t: string) => void (files[p] = t),
	};

	it('keeps the same cards, the same ids, and backs every file up', async () => {
		const originals = { ...files };
		expect(await migrateCardFiles(paths, io)).toBeGreaterThan(0);
		const cards = paths.flatMap((p) => parseCardFile(files[p] as string));
		expect(cards.map((c) => c.id)).toEqual(before);
		expect(new Set(before).size).toBe(before.length);
		for (const c of cards) {
			expect(c.front).not.toBe('');
			expect(c.source).toMatch(/^\[\[/);
		}
		for (const p of paths) if (files[p] !== originals[p]) expect(files[`${p}.backup-pre-migration`]).toBe(originals[p]);
		process.stdout.write(`fixture: ${paths.length} files, ${cards.length} cards, ${new Set(cards.map((c) => c.type)).size} types\n`);
	});

	it('every id in the state still has its card, and the log loses none that had one', () => {
		const ids = new Set(paths.flatMap((p) => parseCardFile(files[p] as string).map((c) => c.id)));
		expect(ids).toEqual(new Set(before));
		const state = JSON.parse(readFileSync(join(dir as string, 'estado.json'), 'utf8')) as Record<string, unknown>;
		const known = (key: string) => ids.has(key.replace(/-.*$/, ''));
		expect(Object.keys(state).filter((k) => !k.startsWith('nota:') && !k.startsWith('note:') && !known(k))).toEqual([]);
		const log = readFileSync(join(dir as string, 'revisoes.jsonl'), 'utf8').split('\n').filter(Boolean);
		const logIds = log.map((l) => (JSON.parse(l) as { id: string }).id.replace(/-.*$/, ''));
		expect(logIds.filter((k) => ids.has(k))).toEqual(logIds.filter((k) => before.includes(k)));
	});

	it('a second run changes nothing', async () => {
		const snapshot = { ...files };
		expect(await migrateCardFiles(paths, io)).toBe(0);
		expect(files).toEqual(snapshot);
	});
});
