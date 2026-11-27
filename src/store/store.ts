import { App, normalizePath, Notice, TFile, Vault } from 'obsidian';
import { appendCard, deckPath, ensureIds, newId, parseCardFile, removeCard, replaceCard, serializeCard } from '../core/format';
import type { Card, CardState, RevlogEntry } from '../core/types';
import { DEVICES_DIR, isConflictPath, mergeLogs, mergeStates, newDeviceId, parseLogLines, parseStateText } from './data';

type NewCard = Omit<Card, 'start' | 'end' | 'file'>;

/** Everything Revisit keeps lives in one vault folder: card files, state.json and review-log.jsonl. */
export class Store {
	cards: Card[] = [];
	state: Record<string, CardState> = {};
	log: RevlogEntry[] = [];
	/** only what THIS device wrote: the file it saves; the merged `state` is never written back */
	private own: Record<string, CardState> = {};
	private lastSaved: string | null = null;
	/** card loads run one at a time: two of them at once could give the same card two ids */
	private loading: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private folder: () => string,
	) {}

	/** this device's id: kept per device (local storage never syncs) */
	get deviceId(): string {
		if (this.id) return this.id;
		const saved: unknown = this.app.loadLocalStorage('revisit-device');
		if (typeof saved === 'string' && saved) this.id = saved;
		else {
			this.id = newDeviceId();
			this.app.saveLocalStorage('revisit-device', this.id);
		}
		return this.id;
	}
	private id = '';

	/** true for files this plugin writes for other devices or for itself under devices/ */
	isDevicePath(path: string): boolean {
		return path.startsWith(`${this.base}/${DEVICES_DIR}/`);
	}
	isOwnPath(path: string): boolean {
		return path.startsWith(`${this.base}/${DEVICES_DIR}/${this.deviceId}/`);
	}
	private get ownDir(): string {
		return `${DEVICES_DIR}/${this.deviceId}`;
	}

	private get base(): string {
		return normalizePath(this.folder());
	}
	private path(name: string): string {
		return `${this.base}/${name}`;
	}

	/** The state file of a folder first; when it is unreadable, the last good copy written before it. */
	private async readState(dir: string): Promise<Record<string, CardState>> {
		const adapter = this.app.vault.adapter;
		for (const name of ['state.json', 'state.backup.json']) {
			const path = dir ? `${this.base}/${dir}/${name}` : this.path(name);
			try {
				if (await adapter.exists(path)) return parseStateText(await adapter.read(path));
			} catch (e) {
				new Notice(`Revisit: ${path} is unreadable (${e instanceof Error ? e.message : String(e)}); trying the backup.`);
			}
		}
		return {};
	}

	private async readLog(dir: string): Promise<RevlogEntry[]> {
		const path = dir ? `${this.base}/${dir}/review-log.jsonl` : this.path('review-log.jsonl');
		if (!(await this.app.vault.adapter.exists(path))) return [];
		const parsed = parseLogLines(await this.app.vault.adapter.read(path));
		if (parsed.bad) new Notice(`Revisit: ${parsed.bad} unreadable line(s) ignored in ${path}.`);
		return parsed.entries;
	}

	/** Device folders under devices/ (conflict copies skipped). */
	private async deviceDirs(): Promise<string[]> {
		const root = `${this.base}/${DEVICES_DIR}`;
		if (!(await this.app.vault.adapter.exists(root))) return [];
		const { folders } = await this.app.vault.adapter.list(root);
		return folders
			.filter((f) => !isConflictPath(f))
			.map((f) => `${DEVICES_DIR}/${f.split('/').pop() ?? ''}`)
			.sort();
	}

	/** State and log of every layer: the legacy root files and each device. Used on open and when another device's files change. */
	async loadShared(): Promise<void> {
		const dirs = ['', ...(await this.deviceDirs())];
		const states = await Promise.all(dirs.map((d) => this.readState(d)));
		const logs = await Promise.all(dirs.map((d) => this.readLog(d)));
		this.state = mergeStates(states);
		this.log = mergeLogs(logs);
		const own = dirs.indexOf(this.ownDir);
		this.own = own >= 0 ? { ...states[own] } : {};
		this.lastSaved = own >= 0 ? JSON.stringify(states[own]) : null;
	}

	/** Reads everything: state, log and cards. Used on open; during a session only the cards are read again, so a grade in flight is never overwritten. */
	async load(): Promise<void> {
		await this.loadShared();
		await this.loadCards();
	}

	loadCards(): Promise<void> {
		this.loading = this.loading.catch(() => undefined).then(() => this.readCards());
		return this.loading;
	}

	/** Markdown files under the Revisit folder only: the rest of the vault is never listed. */
	private folderFiles(): TFile[] {
		const files: TFile[] = [];
		const root = this.app.vault.getFolderByPath(this.base);
		if (root) Vault.recurseChildren(root, (f) => {
			if (f instanceof TFile && f.extension === 'md') files.push(f);
		});
		return files;
	}

	private async readCards(): Promise<void> {
		const files = this.folderFiles().filter((f) => !this.isDevicePath(f.path) && !isConflictPath(f.path));
		const texts = await Promise.all(files.map((f) => this.app.vault.cachedRead(f)));
		const taken = new Set<string>();
		texts.forEach((t) => parseCardFile(t).forEach((c) => c.id && taken.add(c.id)));
		this.cards = [];
		for (const [i, file] of files.entries()) {
			let text = texts[i] ?? '';
			const fixed = ensureIds(text, taken);
			if (fixed.added) {
				text = fixed.text;
				await this.app.vault.modify(file, text);
			}
			for (const c of parseCardFile(text)) this.cards.push({ ...c, file: file.path });
		}
	}

	private async ensureFolder(path: string): Promise<void> {
		let cur = '';
		for (const p of path.split('/').slice(0, -1)) {
			cur = cur ? `${cur}/${p}` : p;
			if (!(await this.app.vault.adapter.exists(cur))) await this.app.vault.createFolder(cur);
		}
	}

	/** `deck` is the path of an existing or new deck, used as it is; without it the first topic names the file. */
	async addCard(card: NewCard, deck?: string): Promise<string> {
		const taken = new Set(this.cards.map((c) => c.id).filter((x): x is string => !!x));
		const id = card.id ?? newId(taken);
		const block = serializeCard({ ...card, id });
		const path = deck ? this.path(`${deck}.md`) : deckPath(card.topics, this.base);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			await this.app.vault.process(file, (t) => appendCard(t, block));
		} else {
			await this.ensureFolder(path);
			await this.app.vault.create(path, appendCard('', block));
		}
		await this.loadCards();
		return id;
	}

	/** Runs `edit` on the card's current block, found again by id in case the file changed. */
	private async withCard(card: Card, edit: (text: string, fresh: Card) => string): Promise<void> {
		const file = card.file ? this.app.vault.getAbstractFileByPath(card.file) : null;
		if (!(file instanceof TFile)) throw new Error('Card file not found.');
		await this.app.vault.process(file, (text) => {
			const fresh = parseCardFile(text).find((c) => c.id === card.id);
			if (!fresh) throw new Error('Card not found in the file.');
			return edit(text, fresh);
		});
		await this.loadCards();
	}

	async updateCard(card: Card, next: NewCard): Promise<void> {
		await this.withCard(card, (text, fresh) => replaceCard(text, fresh, serializeCard({ ...next, id: card.id })));
	}

	/** The same block, with its id, goes to the file of `deck`: the schedule is kept by id, so it follows. */
	async moveCard(card: Card, deck: string): Promise<void> {
		const to = this.path(`${deck}.md`);
		if (!card.id || card.file === to) return;
		const fresh = this.cards.find((c) => c.id === card.id) ?? card;
		const block = serializeCard({ ...fresh, topics: [deck.split('/').join(' > ')] });
		const file = this.app.vault.getAbstractFileByPath(to);
		// written to the new file first: a failure halfway leaves a copy, never a lost card
		if (file instanceof TFile) await this.app.vault.process(file, (t) => appendCard(t, block));
		else {
			await this.ensureFolder(to);
			await this.app.vault.create(to, appendCard('', block));
		}
		await this.withCard(fresh, (text, found) => removeCard(text, found));
	}

	async deleteCard(card: Card): Promise<void> {
		await this.withCard(card, (text, fresh) => removeCard(text, fresh));
		for (const k of Object.keys(this.state)) if (card.id && (k === card.id || k.startsWith(card.id + '-'))) this.setEntry(k, undefined);
		await this.saveState();
	}

	/** A grade (or the undo of one) on this device: lands in the merged state and in this device's own file. */
	setEntry(key: string, entry: CardState | undefined): void {
		if (entry) {
			this.state[key] = entry;
			this.own[key] = entry;
		} else {
			delete this.state[key];
			delete this.own[key];
		}
	}

	async saveState(): Promise<void> {
		const next = JSON.stringify(this.own);
		if (next === this.lastSaved) return;
		await this.ensureFolder(this.path(`${this.ownDir}/state.json`));
		// the copy written before this one is the recovery point if the write dies halfway
		if (this.lastSaved !== null) await this.app.vault.adapter.write(this.path(`${this.ownDir}/state.backup.json`), this.lastSaved).catch(() => undefined);
		await this.app.vault.adapter.write(this.path(`${this.ownDir}/state.json`), next);
		this.lastSaved = next;
	}

	private get ownLog(): string {
		return this.path(`${this.ownDir}/review-log.jsonl`);
	}

	async appendLog(entry: RevlogEntry): Promise<void> {
		this.log.push(entry);
		await this.ensureFolder(this.ownLog);
		await this.app.vault.adapter.append(this.ownLog, JSON.stringify(entry) + '\n');
	}

	/** Takes back the last line of THIS device's log (undo) when it is the grade of `id`; every other line keeps its bytes. */
	async popLog(id: string): Promise<void> {
		const path = this.ownLog;
		if (!(await this.app.vault.adapter.exists(path))) return;
		const lines = (await this.app.vault.adapter.read(path)).split('\n');
		while (lines.length && !(lines[lines.length - 1] ?? '').trim()) lines.pop();
		const last = lines[lines.length - 1];
		if (last === undefined || !last.includes(`"id":"${id}"`)) return;
		lines.pop();
		const gone = parseLogLines(last).entries[0];
		const i = this.log.findLastIndex((e) => e.id === id && (!gone || e.t === gone.t));
		if (i >= 0) this.log.splice(i, 1);
		await this.app.vault.adapter.write(path, lines.map((l) => l + '\n').join(''));
	}
}
