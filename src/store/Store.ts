import { App, normalizePath, TFile } from 'obsidian';
import { appendCard, ensureIds, newId, parseCardFile, removeCard, replaceCard, serializeCard } from '../cards/format';
import { Card } from '../cards/types';
import { RevlogEntry } from '../srs/budget';
import { StoredFsrs } from '../srs/scheduler';

export type Estado = 'ativo' | 'suspenso';

export interface CardState {
	fsrs?: StoredFsrs;
	st: Estado;
}

/** Everything the Lembro keeps lives in one vault folder. */
export class Store {
	cards: Card[] = [];
	state: Record<string, CardState> = {};
	log: RevlogEntry[] = [];

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
	private get logPath(): string {
		return `${this.base}/revisoes.jsonl`;
	}

	cardFiles(): TFile[] {
		return this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.base + '/'));
	}

	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.state = (await adapter.exists(this.statePath))
			? (JSON.parse(await adapter.read(this.statePath)) as Record<string, CardState>)
			: {};
		this.log = (await adapter.exists(this.logPath))
			? (await adapter.read(this.logPath))
					.split('\n')
					.filter((l) => l.trim())
					.map((l) => JSON.parse(l) as RevlogEntry)
			: [];
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
		await this.ensureFolder(this.statePath);
		await this.app.vault.adapter.write(this.statePath, JSON.stringify(this.state));
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
