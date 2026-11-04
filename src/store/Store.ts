import { App, normalizePath, Notice, TFile } from 'obsidian';
import { appendCard, appendCards, ensureIds, newId, parseCardFile, removeCard, replaceCard, serializeCard } from '../cards/format';
import { Card } from '../cards/types';
import { RevlogEntry } from '../srs/budget';
import { StoredFsrs } from '../srs/scheduler';
import { Reread } from '../notes/reread';
import { parseStateText, parseLogLines } from './parse';

export type Estado = 'active' | 'suspended';

export interface CardState {
	fsrs?: StoredFsrs;
	/** notes to reread live here too, under the key `note:<path>` */
	reread?: Reread;
	st: Estado;
}

/** Everything the Lembro keeps lives in one vault folder. */
export class Store {
	cards: Card[] = [];
	state: Record<string, CardState> = {};
	log: RevlogEntry[] = [];
	/** goes up whenever cards or state change on disk; keys the items() memo */
	version = 0;
	private lastSavedState: string | null = null;

	constructor(
		private app: App,
		private folder: () => string,
	) {}

	private get base(): string {
		return normalizePath(this.folder());
	}
	private get statePath(): string {
		return `${this.base}/estado.json`;
	}
	private get backupPath(): string {
		return `${this.base}/estado.backup.json`;
	}
	private get logPath(): string {
		return `${this.base}/revisoes.jsonl`;
	}

	cardFiles(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.base + '/'));
	}

	/** estado.json first; when it is unreadable, the last good copy written before it. */
	private async readState(): Promise<Record<string, CardState>> {
		for (const path of [this.statePath, this.backupPath]) {
			try {
				if (!(await this.app.vault.adapter.exists(path))) continue;
				return parseStateText(await this.app.vault.adapter.read(path));
			} catch (e) {
				new Notice(`Lembro: ${path} está ilegível (${e instanceof Error ? e.message : String(e)}); tentando o backup.`);
			}
		}
		return {};
	}

	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.state = await this.readState();
		this.lastSavedState = JSON.stringify(this.state);
		this.log = [];
		if (await adapter.exists(this.logPath)) {
			const parsed = parseLogLines(await adapter.read(this.logPath));
			this.log = parsed.entries;
			if (parsed.bad) new Notice(`Lembro: ${parsed.bad} linha(s) ilegível(is) ignoradas em revisoes.jsonl.`);
		}
		const taken = new Set<string>();
		const files = this.cardFiles();
		const texts = await Promise.all(files.map((f) => this.app.vault.cachedRead(f)));
		texts.forEach((t) => parseCardFile(t).forEach((c) => c.id && taken.add(c.id)));
		const cards: Card[] = [];
		for (const [i, file] of files.entries()) {
			let text = texts[i] ?? '';
			const fixed = ensureIds(text, taken);
			if (fixed.added) {
				text = fixed.text;
				await this.app.vault.modify(file, text);
			}
			for (const c of parseCardFile(text)) cards.push({ ...c, file: file.path });
		}
		this.cards = cards;
		this.version++;
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
		const file = card.file ? this.app.vault.getAbstractFileByPath(card.file) : null;
		if (!(file instanceof TFile)) throw new Error('Arquivo do cartão não encontrado.');
		await this.app.vault.process(file, (text) => {
			const fresh = parseCardFile(text).find((c) => c.id === card.id);
			if (!fresh) throw new Error('Cartão não encontrado no arquivo.');
			return edit(text, fresh);
		});
		await this.load();
	}

	async updateCard(card: Card, next: Omit<Card, 'start' | 'end' | 'file'>): Promise<void> {
		await this.withCardFile(card, (text, fresh) => replaceCard(text, fresh, serializeCard({ ...next, id: card.id })));
	}

	async deleteCard(card: Card): Promise<void> {
		await this.withCardFile(card, (text, fresh) => removeCard(text, fresh));
		if (card.id) delete this.state[card.id];
		await this.saveState();
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
		await this.ensureFolder(this.logPath);
		await this.app.vault.adapter.append(this.logPath, JSON.stringify(entry) + '\n');
	}

	/** Takes back the last log line (undo). */
	async popLog(): Promise<void> {
		this.log.pop();
		await this.app.vault.adapter.write(this.logPath, this.log.map((e) => JSON.stringify(e) + '\n').join(''));
	}
}
