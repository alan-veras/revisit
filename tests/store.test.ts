import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
	normalizePath: (p: string) => p,
	Notice: class {},
	TFile: class {},
}));

const { Store } = await import('../src/store/store');

/** A vault adapter in memory: path → text. */
function fakeApp(files: Map<string, string>, id: string) {
	const ls = new Map<string, string>([['revisit-device', id]]);
	const adapter = {
		exists: (p: string) => Promise.resolve(files.has(p) || [...files.keys()].some((k) => k.startsWith(p + '/'))),
		read: (p: string) => Promise.resolve(files.get(p) ?? ''),
		write: (p: string, t: string) => Promise.resolve(void files.set(p, t)),
		append: (p: string, t: string) => Promise.resolve(void files.set(p, (files.get(p) ?? '') + t)),
		list: (p: string) => {
			const kids = new Set<string>();
			for (const k of files.keys()) if (k.startsWith(p + '/')) kids.add(p + '/' + k.slice(p.length + 1).split('/')[0]);
			return Promise.resolve({ files: [], folders: [...kids] });
		},
	};
	return {
		vault: { adapter, getMarkdownFiles: () => [], createFolder: () => Promise.resolve() },
		loadLocalStorage: (k: string) => ls.get(k) ?? null,
		saveLocalStorage: (k: string, v: string) => ls.set(k, v),
	} as never;
}
const line = (id: string, t: string) => JSON.stringify({ id, t, grade: 3, seconds: 1, type: 'Question', new: false, extra: false }) + '\n';

describe('store with two devices', () => {
	const files = new Map<string, string>([
		['R/review-log.jsonl', line('old', '2026-11-01T10:00:00Z')],
		['R/devices/aaaaaa/review-log.jsonl', line('a1', '2026-11-02T10:00:00Z')],
		['R/devices/bbbbbb/review-log.jsonl', line('b1', '2026-11-03T10:00:00Z') + line('b2', '2026-11-04T10:00:00Z')],
		['R/devices/bbbbbb/review-log.sync-conflict-1.jsonl', line('zz', '2026-11-05T10:00:00Z')],
		['R/devices/aaaaaa/state.json', '{"x":{"st":"active","fsrs":{"state":2,"due":"2026-12-01T00:00:00Z","last_review":"2026-11-02T10:00:00Z"}}}'],
		['R/devices/bbbbbb/state.json', '{"x":{"st":"active","fsrs":{"state":2,"due":"2026-12-09T00:00:00Z","last_review":"2026-11-04T10:00:00Z"}}}'],
		['R/devices/bbbbbb/state.sync-conflict-1.json', '{"x":{"st":"suspended"}}'],
	]);
	it('reads every layer, ignores conflict files, sorted', async () => {
		const s = new Store(fakeApp(files, 'aaaaaa'), () => 'R');
		await s.loadShared();
		expect(s.log.map((e) => e.id)).toEqual(['old', 'a1', 'b1', 'b2']);
		expect(s.state.x?.fsrs?.due).toBe('2026-12-09T00:00:00Z');
	});
	it('undo only pops the log of this device', async () => {
		const s = new Store(fakeApp(files, 'aaaaaa'), () => 'R');
		await s.loadShared();
		await s.popLog('b2');
		expect(files.get('R/devices/bbbbbb/review-log.jsonl')).toContain('b2');
		await s.popLog('a1');
		expect(files.get('R/devices/aaaaaa/review-log.jsonl')).toBe('');
		expect(files.get('R/review-log.jsonl')).toContain('old');
		expect(s.log.map((e) => e.id)).toEqual(['old', 'b1', 'b2']);
	});
	it('writes only its own files', async () => {
		const before = new Map(files);
		const s = new Store(fakeApp(files, 'cccccc'), () => 'R');
		await s.loadShared();
		await s.appendLog({ id: 'c1', t: '2026-11-06T10:00:00Z', grade: 3, seconds: 1, type: 'Question', new: false, extra: false });
		await s.saveState();
		const changed = [...files.keys()].filter((k) => before.get(k) !== files.get(k));
		expect(changed.every((k) => k.startsWith('R/devices/cccccc/'))).toBe(true);
		expect(changed.length).toBeGreaterThan(0);
	});
});

describe('own state layer', () => {
	const entry = (due: string, last: string) => ({ st: 'active' as const, fsrs: { state: 2, due, last_review: last } as never });
	it('writes only what this device changed, so an undo is not brought back by a copy', async () => {
		const files = new Map<string, string>([['R/devices/bbbbbb/state.json', JSON.stringify({ x: entry('2026-12-01T00:00:00Z', '2026-11-04T10:00:00Z') })]]);
		const s = new Store(fakeApp(files, 'aaaaaa'), () => 'R');
		await s.loadShared();
		s.setEntry('y', entry('2026-12-02T00:00:00Z', '2026-11-05T10:00:00Z'));
		await s.saveState();
		expect(Object.keys(JSON.parse(files.get('R/devices/aaaaaa/state.json') ?? '{}') as object)).toEqual(['y']);
		expect(Object.keys(s.state).sort()).toEqual(['x', 'y']);
		s.setEntry('y', undefined);
		await s.saveState();
		expect(JSON.parse(files.get('R/devices/aaaaaa/state.json') ?? '{}') as object).toEqual({});
		expect(Object.keys(s.state)).toEqual(['x']);
	});
	it('a cleared local storage is a new device and the old files still count', async () => {
		const files = new Map<string, string>([['R/devices/old111/state.json', JSON.stringify({ x: entry('2026-12-01T00:00:00Z', '2026-11-04T10:00:00Z') })]]);
		const s = new Store(fakeApp(files, 'new222'), () => 'R');
		await s.loadShared();
		expect(s.state.x?.fsrs?.due).toBe('2026-12-01T00:00:00Z');
	});
});
