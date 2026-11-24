import { App, normalizePath, Notice, TFile } from 'obsidian';
import { appendCard, deckPath, ensureIds, newId, parseCardFile, removeCard, replaceCard, serializeCard } from '../core/format';
import type { Card, CardState, RevlogEntry } from '../core/types';
import { parseLogLines, parseStateText } from './data';

type NewCard = Omit<Card, 'start' | 'end' | 'file'>;

/** Everything Revisit keeps lives in one vault folder: card files, state.json and review-log.jsonl. */
export class Store {
	cards: Card[] = [];
	state: Record<string, CardState> = {};
	log: RevlogEntry[] = [];
	private lastSaved: string | null = null;
	/** card loads run one at a time: two of them at once could give the same card two ids */
	private loading: Promise<void> = Promise.resolve();

	constructor(
		private app: App,
		private folder: () => string,
	) {}

	private get base(): string {
		return normalizePath(this.folder());
	}
	private path(name: string): string {
		return `${this.base}/${name}`;
	}

	/** The state file first; when it is unreadable, the last good copy written before it. */
	private async readState(): Promise<Record<string, CardState>> {
		const adapter = this.app.vault.adapter;
		for (const name of ['state.json', 'state.backup.json']) {
			try {
				if (await adapter.exists(this.path(name))) return parseStateText(await adapter.read(this.path(name)));
			} catch (e) {
				new Notice(`Revisit: ${name} is unreadable (${e instanceof Error ? e.message : String(e)}); trying the backup.`);
			}
		}
		return {};
	}

	/** Reads everything: state, log and cards. Used on open; during a session only the cards are read again, so a grade in flight is never overwritten. */
	async load(): Promise<void> {
		const adapter = this.app.vault.adapter;
		this.state = await this.readState();
		this.lastSaved = JSON.stringify(this.state);
		this.log = [];
		if (await adapter.exists(this.path('review-log.jsonl'))) {
			const parsed = parseLogLines(await adapter.read(this.path('review-log.jsonl')));
			this.log = parsed.entries;
			if (parsed.bad) new Notice(`Revisit: ${parsed.bad} unreadable line(s) ignored in review-log.jsonl.`);
		}
		await this.loadCards();
	}

	loadCards(): Promise<void> {
		this.loading = this.loading.catch(() => undefined).then(() => this.readCards());
		return this.loading;
	}

	private async readCards(): Promise<void> {
		const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(this.base + '/'));
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

	async addCard(card: NewCard): Promise<string> {
		const taken = new Set(this.cards.map((c) => c.id).filter((x): x is string => !!x));
		const id = card.id ?? newId(taken);
		const block = serializeCard({ ...card, id });
		const path = deckPath(card.topics, this.base);
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

	async deleteCard(card: Card): Promise<void> {
		await this.withCard(card, (text, fresh) => removeCard(text, fresh));
		for (const k of Object.keys(this.state)) if (card.id && (k === card.id || k.startsWith(card.id + '-'))) delete this.state[k];
		await this.saveState();
	}

	async saveState(): Promise<void> {
		const next = JSON.stringify(this.state);
		if (next === this.lastSaved) return;
		await this.ensureFolder(this.path('state.json'));
		// the copy written before this one is the recovery point if the write dies halfway
		if (this.lastSaved !== null) await this.app.vault.adapter.write(this.path('state.backup.json'), this.lastSaved).catch(() => undefined);
		await this.app.vault.adapter.write(this.path('state.json'), next);
		this.lastSaved = next;
	}

	async appendLog(entry: RevlogEntry): Promise<void> {
		this.log.push(entry);
		await this.ensureFolder(this.path('review-log.jsonl'));
		await this.app.vault.adapter.append(this.path('review-log.jsonl'), JSON.stringify(entry) + '\n');
	}

	/** Takes back the last log line (undo) when it is the grade of `id`; every other line keeps its bytes. */
	async popLog(id: string): Promise<void> {
		if (this.log.at(-1)?.id === id) this.log.pop();
		const path = this.path('review-log.jsonl');
		const lines = (await this.app.vault.adapter.read(path)).split('\n');
		while (lines.length && !(lines.at(-1) ?? '').trim()) lines.pop();
		const last = lines.at(-1);
		if (last === undefined || !last.includes(`"id":"${id}"`)) return;
		lines.pop();
		await this.app.vault.adapter.write(path, lines.map((l) => l + '\n').join(''));
	}
}
