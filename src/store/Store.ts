import { App, getAllTags, normalizePath, Notice, TFile } from 'obsidian';
import { appendCard, appendCards, ensureIds, groupBy, newId, parseCardFile, removeCard, replaceCard, retagTopics, rewriteTopics, serializeCard, splitBlocks } from '../cards/format';
import { deckPath } from '../cards/mirror';
import { parseInlineCards } from '../cards/inline';
import { Card } from '../cards/types';
import type { CardLayout } from '../settings';
import { RevlogEntry } from '../srs/budget';
import { StoredFsrs } from '../srs/scheduler';
import { Reread } from '../notes/reread';
import { DATA_FILES, migrateCardFiles, migrateDataFiles, planDeckMigration } from './migrate';
import { parseStateText, parseLogLines } from './parse';

export type Status = 'active' | 'suspended';

export interface CardState {
	fsrs?: StoredFsrs;
	/** notes to reread live here too, under the key `note:<path>` */
	reread?: Reread;
	st: Status;
}

/** True when the note carries the tag or one under it (`#a` matches `#a/b`). */
export function noteHasTag(app: App, file: TFile, tag: string): boolean {
	const want = tag.toLowerCase();
	const cache = app.metadataCache.getFileCache(file);
	return !!cache && (getAllTags(cache) ?? []).some((t) => t.toLowerCase() === want || t.toLowerCase().startsWith(want + '/'));
}

/** Everything Revisit keeps lives in one vault folder. */
export class Store {
	cards: Card[] = [];
	state: Record<string, CardState> = {};
	log: RevlogEntry[] = [];
	/** the log lines as read, so undo rewrites the file without touching the bytes of the kept lines */
	private rawLog: string[] = [];
	/** goes up whenever cards or state change on disk; keys the items() memo */
	version = 0;
	private lastSavedState: string | null = null;

	constructor(
		private app: App,
		private folder: () => string,
		private inlineTag: () => string = () => '',
		private layout: () => CardLayout = () => 'deck',
		private setLayout: (l: CardLayout) => Promise<void> = async () => {},
	) {}

	private get base(): string {
		return normalizePath(this.folder());
	}
	private get statePath(): string {
		return `${this.base}/${DATA_FILES.state}`;
	}
	private get backupPath(): string {
		return `${this.base}/${DATA_FILES.stateBackup}`;
	}
	private get logPath(): string {
		return `${this.base}/${DATA_FILES.log}`;
	}

	cardFiles(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.base + '/'));
	}

	private get migrationBackupPath(): string {
		return `${this.statePath}.backup-pre-migration`;
	}

	/** The state file first; when it is unreadable, the last good copy written before it. The old Portuguese schema is migrated: backed up once, then persisted in English right away. */
	private async readState(): Promise<Record<string, CardState>> {
		for (const path of [this.statePath, this.backupPath]) {
			try {
				if (!(await this.app.vault.adapter.exists(path))) continue;
				const text = await this.app.vault.adapter.read(path);
				const { state, changed } = parseStateText(text);
				if (changed && path === this.statePath) {
					if (!(await this.app.vault.adapter.exists(this.migrationBackupPath)))
						await this.app.vault.adapter.write(this.migrationBackupPath, text);
					await this.app.vault.adapter.write(this.statePath, JSON.stringify(state));
				}
				return state;
			} catch (e) {
				new Notice(`Revisit: ${path} is unreadable (${e instanceof Error ? e.message : String(e)}); trying the backup.`);
			}
		}
		return {};
	}

	/** Files named the way older versions did move to the current names, once; nothing happens in a vault that never had them. */
	private async migrateDataFiles(): Promise<void> {
		const adapter = this.app.vault.adapter;
		try {
			const moved = await migrateDataFiles(this.base, {
				read: (path) => adapter.read(path),
				exists: (path) => adapter.exists(path),
				write: (path, text) => adapter.write(path, text),
				rename: (from, to) => adapter.rename(from, to),
			});
			if (moved.length) new Notice(`Revisit: ${moved.length} data ${moved.length === 1 ? 'file' : 'files'} renamed; the originals are kept beside them as .backup-pre-migration.`);
		} catch (e) {
			new Notice(`Revisit: could not rename the data files (${e instanceof Error ? e.message : String(e)}). The old ones are untouched.`);
		}
	}

	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		await this.migrateDataFiles();
		this.state = await this.readState();
		this.lastSavedState = JSON.stringify(this.state);
		this.log = [];
		this.rawLog = [];
		if (await adapter.exists(this.logPath)) {
			const parsed = parseLogLines(await adapter.read(this.logPath));
			this.log = parsed.entries;
			this.rawLog = parsed.lines;
			if (parsed.bad) new Notice(`Revisit: ${parsed.bad} unreadable line(s) ignored in ${DATA_FILES.log}.`);
		}
		const files = this.cardFiles();
		await this.migrateCards(files);
		await this.migrateToDecks();
		const current = this.cardFiles();
		const taken = new Set<string>();
		const texts = await Promise.all(current.map((f) => this.app.vault.cachedRead(f)));
		texts.forEach((t) => parseCardFile(t).forEach((c) => c.id && taken.add(c.id)));
		const cards: Card[] = [];
		for (const [i, file] of current.entries()) {
			let text = texts[i] ?? '';
			const fixed = ensureIds(text, taken);
			if (fixed.added) {
				text = fixed.text;
				await this.app.vault.modify(file, text);
			}
			for (const c of parseCardFile(text)) cards.push({ ...c, file: file.path });
		}
		this.cards = cards.concat(await this.inlineCards(taken));
		this.version++;
	}

	/** Cards written inside the notes with the inline tag; nothing is written back. */
	private async inlineCards(taken: Set<string>): Promise<Card[]> {
		const tag = this.inlineTag();
		if (!tag) return [];
		const notes = this.app.vault.getMarkdownFiles().filter((f) => !f.path.startsWith(this.base + '/') && noteHasTag(this.app, f, tag));
		const out: Card[] = [];
		for (const f of notes) {
			const link = `[[${f.path.replace(/\.md$/, '')}|${f.basename}]]`;
			for (const c of parseInlineCards(await this.app.vault.cachedRead(f), link)) {
				if (taken.has(c.id as string)) continue;
				taken.add(c.id as string);
				out.push({ ...c, file: f.path });
			}
		}
		return out;
	}

	/** Card files still in the old format move to the English one; a vault without them does nothing here. */
	private async migrateCards(files: TFile[]): Promise<void> {

		const byPath = new Map(files.map((f) => [f.path, f]));
		const fileAt = (path: string) => {
			const file = byPath.get(path);
			if (!file) throw new Error(`Card file not found: ${path}`);
			return file;
		};
		const adapter = this.app.vault.adapter;
		const done = await migrateCardFiles([...byPath.keys()], {
			read: (path) => this.app.vault.cachedRead(fileAt(path)),
			exists: (path) => adapter.exists(path),
			write: async (path, text) => {
				const file = byPath.get(path);
				if (file) await this.app.vault.modify(file, text);
				else await adapter.write(path, text);
			},
		});
		if (done) new Notice(`Revisit: ${done} card ${done === 1 ? 'file' : 'files'} moved to the new format; the originals are kept beside them as .backup-pre-migration.`);
	}

	/** One-time move from one file per source note to one file per deck; a vault already on the deck layout does nothing here. */
	private async migrateToDecks(): Promise<void> {
		if (this.layout() === 'deck') return;
		const adapter = this.app.vault.adapter;
		const entries = await Promise.all(this.cardFiles().map(async (f) => ({ path: f.path, text: await this.app.vault.cachedRead(f) })));
		const plan = planDeckMigration(entries, this.base);
		if (plan.writes.length || plan.removes.length) {
			for (const b of plan.backups) if (!(await adapter.exists(b.target))) await adapter.write(b.target, b.text);
			for (const w of plan.writes) {
				await this.ensureFolder(w.path);
				await adapter.write(w.path, w.text);
			}
			for (const r of plan.removes) if (await adapter.exists(r)) await adapter.remove(r);
			await this.pruneEmptyDirs();
			new Notice('Revisit: cards moved to one file per deck; every original is kept as .backup-pre-deck.');
		}
		await this.setLayout('deck');
	}

	/** Moves cards whose file is not the file of their deck (after a topic change): one write per source file, one per target. */
	private async relocateMisplaced(): Promise<void> {
		const moving = this.cards.filter((c) => c.id && !c.inline && c.file && c.file.startsWith(this.base + '/') && deckPath(c.topics, this.base) !== c.file);
		if (!moving.length) return;
		for (const [src, group] of groupBy(moving, (c) => c.file as string)) {
			const file = this.app.vault.getAbstractFileByPath(src);
			if (!(file instanceof TFile)) continue;
			await this.app.vault.process(file, (text) => {
				let out = text;
				for (const card of [...group].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))) out = removeCard(out, card);
				return out;
			});
		}
		const portable = (c: Card): Omit<Card, 'start' | 'end' | 'file' | 'inline'> => {
			const { start: _s, end: _e, file: _f, inline: _i, ...rest } = c;
			return rest;
		};
		for (const [dest, group] of groupBy(moving, (c) => deckPath(c.topics, this.base))) await this.addCards(dest, group.map(portable));
		await this.pruneEmptyFiles();
		await this.pruneEmptyDirs();
		await this.load();
	}

	/** Deletes card files left with no card block (an emptied deck file has no reason to stay). */
	private async pruneEmptyFiles(): Promise<void> {
		for (const f of this.cardFiles()) {
			if (splitBlocks(await this.app.vault.cachedRead(f)).length) continue;
			await this.app.vault.adapter.remove(f.path);
		}
	}

	/** Removes folders under the base that no file of any kind remains in, deepest first. */
	private async pruneEmptyDirs(): Promise<void> {
		const removeEmpty = async (dir: string): Promise<number> => {
			const listing = await this.app.vault.adapter.list(dir);
			let left = listing.files.length;
			for (const sub of listing.folders) left += await removeEmpty(sub);
			if (!left && dir !== this.base) await this.app.vault.adapter.rmdir(dir, false);
			return left;
		};
		for (const sub of (await this.app.vault.adapter.list(this.base)).folders) await removeEmpty(sub);
	}

	takenIds(): Set<string> {
		return new Set(this.cards.map((c) => c.id).filter((x): x is string => !!x));
	}

	private async ensureFolder(path: string): Promise<void> {
		const parts = path.split('/').slice(0, -1);
		let cur = '';
		for (const p of parts) {
			cur = cur ? `${cur}/${p}` : p;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.createFolder(cur);
		}
	}

	async addCard(path: string, card: Omit<Card, 'start' | 'end' | 'file'>): Promise<string> {
		const id = card.id ?? newId(this.takenIds());
		const block = serializeCard({ ...card, id });
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.process(file, (t) => appendCard(t, block));
		} else {
			await this.ensureFolder(path);
			await this.app.vault.create(path, appendCard('', block));
		}
		await this.load();
		return id;
	}

	/**
	 * Adds several cards to one file in a single write. Writing them one by one let a
	 * concurrent stale write (a reload, another plugin) drop a card now and then.
	 * Cards that already have an id keep it, so a retry does not duplicate them.
	 */
	async addCards(path: string, cards: Omit<Card, 'start' | 'end' | 'file'>[]): Promise<string[]> {
		const taken = this.takenIds();
		const withIds = cards.map((c) => ({ ...c, id: c.id ?? newId(taken) }));
		const blocks = withIds.map((c) => serializeCard(c));
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.process(file, (t) => appendCards(t, blocks));
		} else {
			await this.ensureFolder(path);
			await this.app.vault.create(path, appendCards('', blocks));
		}
		return withIds.map((c) => c.id);
	}

	private async withCardFile(card: Card, edit: (text: string, fresh: Card) => string): Promise<void> {
		if (card.inline) throw new Error('This card is written in a note: change it there.');
		const file = card.file ? this.app.vault.getAbstractFileByPath(card.file) : null;
		if (!(file instanceof TFile)) throw new Error('Card file not found.');
		await this.app.vault.process(file, (text) => {
			const fresh = parseCardFile(text).find((c) => c.id === card.id);
			if (!fresh) throw new Error('Card not found in the file.');
			return edit(text, fresh);
		});
		await this.load();
	}

	async updateCard(card: Card, next: Omit<Card, 'start' | 'end' | 'file'>): Promise<void> {
		await this.withCardFile(card, (text, fresh) => replaceCard(text, fresh, serializeCard({ ...next, id: card.id })));
		if (deckPath(next.topics, this.base) !== card.file) await this.relocateMisplaced();
	}

	async deleteCard(card: Card): Promise<void> {
		await this.withCardFile(card, (text, fresh) => removeCard(text, fresh));
		// the card and its siblings (reverse, other highlights) lose their schedule
		if (card.id)
			for (const k of Object.keys(this.state))
				if (k === card.id || k.startsWith(card.id + '-')) delete this.state[k];
		await this.saveState();
		await this.pruneEmptyFiles();
	}

	/** Renames a topic (and every `from > …` under it) on all card files; an empty `to` removes the topic. */
	async renameTopic(from: string, to: string): Promise<number> {
		let changed = 0;
		const needle = from.toLowerCase();
		for (const file of this.cardFiles()) {
			const text = await this.app.vault.cachedRead(file);
			if (!text.toLowerCase().includes(needle)) continue;
			await this.app.vault.process(file, (t) => {
				const r = rewriteTopics(t, (card) => retagTopics(card.topics, from, to));
				changed += r.changed;
				return r.text;
			});
		}
		if (changed) {
			await this.load();
			await this.relocateMisplaced();
		}
		return changed;
	}

	/** Sets the topics of specific cards (mirror-file cards only), one write per card file. */
	async setTopics(cards: Card[], topics: string[]): Promise<number> {
		const target = cards.filter((c) => !c.inline && c.id);
		if (!target.length) return 0;
		const ids = new Set(target.map((c) => c.id as string));
		const byPath = new Map<string, Card[]>();
		for (const c of target) {
			if (!c.file) continue;
			const g = byPath.get(c.file);
			if (g) g.push(c);
			else byPath.set(c.file, [c]);
		}
		let changed = 0;
		for (const path of byPath.keys()) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) continue;
			await this.app.vault.process(file, (text) => {
				const r = rewriteTopics(text, (card) => (card.id && ids.has(card.id) ? topics : null));
				changed += r.changed;
				return r.text;
			});
		}
		if (changed) {
			await this.load();
			await this.relocateMisplaced();
		}
		return changed;
	}

	async saveState(): Promise<void> {
		const next = JSON.stringify(this.state);
		if (next === this.lastSavedState) return;
		await this.ensureFolder(this.statePath);
		// the copy written before this one is the recovery point if the write dies halfway
		if (this.lastSavedState !== null) {
			try {
				await this.app.vault.adapter.write(this.backupPath, this.lastSavedState);
			} catch {
				// the backup is best-effort; the main write still happens
			}
		}
		await this.app.vault.adapter.write(this.statePath, next);
		this.lastSavedState = next;
		this.version++;
	}

	async appendLog(entry: RevlogEntry): Promise<void> {
		this.log.push(entry);
		this.rawLog.push(JSON.stringify(entry));
		await this.ensureFolder(this.logPath);
		await this.app.vault.adapter.append(this.logPath, JSON.stringify(entry) + '\n');
	}

	/** Takes back the last log line (undo); the kept lines keep their original bytes, Portuguese or English. */
	async popLog(): Promise<void> {
		this.log.pop();
		this.rawLog.pop();
		await this.app.vault.adapter.write(this.logPath, this.rawLog.map((l) => l + '\n').join(''));
	}
}
