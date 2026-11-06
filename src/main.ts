import { normalizePath, Notice, Plugin, SuggestModal, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { linkPath } from './cards/link';
import { clozes } from './cards/cloze';
import { daysLabel, dueNotes, RereadGrade, read, Reread } from './notes/reread';
import { mirrorPath } from './cards/mirror';
import { Card } from './cards/types';
import { bibleReference, initialType, splitAlternatives } from './capture/autoType';
import { CaptureModal, CaptureResult, draftFromCard } from './capture/CaptureModal';
import { captureContext, headingAbove, sourceLink } from './capture/selection';
import { renameSource, renameSourceFolder } from './cards/format';
import { ReviewView, VIEW_TYPE_REVIEW } from './review/ReviewView';
import { StartModal } from './review/StartModal';
import { DEFAULT_SETTINGS, RevisitSettings, RevisitSettingTab } from './settings';
import { newToday, QuotaStatus, quotaStatus, secsPerType } from './srs/budget';
import { buildSession, dueReviews, estimateMinutes, QueueItem, reviewScopes } from './srs/queue';
import type { Card as FsrsCard } from 'ts-fsrs';
import { fromStored, isNew, Scheduler } from './srs/scheduler';
import { nearestChoice, sessionChoices } from './srs/session';
import { migrateSettings } from './store/migrate';
import { noteHasTag, Store } from './store/Store';
import { PanelView, VIEW_TYPE_PANEL } from './view/PanelView';
import { isSource, NoteCardsView, VIEW_TYPE_NOTE } from './view/NoteCardsView';
import { registerCli } from './cli/commands';

export default class RevisitPlugin extends Plugin {
	settings: RevisitSettings = DEFAULT_SETTINGS;
	store!: Store;
	scheduler!: Scheduler;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.scheduler = new Scheduler(this.settings.retention, this.settings.retentionImportant);
		this.store = new Store(this.app, () => this.settings.folder, () => this.settings.inlineTag);
		this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));
		this.registerView(VIEW_TYPE_PANEL, (leaf: WorkspaceLeaf) => new PanelView(leaf, this));
		this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => void this.openPanel() });
		this.addSettingTab(new RevisitSettingTab(this.app, this));
		registerCli(this);

		this.addCommand({ id: 'capture', name: 'Add to review', callback: () => void this.capture() });
		this.addCommand({ id: 'review', name: 'Review', callback: () => void this.chooseReview(null) });
		this.addCommand({ id: 'review-scope', name: 'Review this note/folder', callback: () => this.pickScope() });
		this.addCommand({ id: 'review-extra', name: 'Extra session before an exam', callback: () => this.pickScope(true) });
		this.addCommand({ id: 'reread-toggle', name: 'Reread this note from time to time (toggle)', callback: () => void this.toggleReread(this.app.workspace.getActiveFile()) });
		this.addCommand({ id: 'reread-next', name: 'Reread the next note', callback: () => void this.openNextReread() });
		this.addCommand({ id: 'note-cards', name: 'Cards of this note', callback: () => void this.openNoteCards() });
		this.addCommand({ id: 'review-note', name: 'Review the cards of this note', callback: () => void this.reviewNote(this.app.workspace.getActiveFile() ?? this.lastSource) });
		this.registerView(VIEW_TYPE_NOTE, (leaf: WorkspaceLeaf) => new NoteCardsView(leaf, this));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (file instanceof TFolder) menu.addItem((i) => i.setTitle('Review the cards of this folder').setIcon('layers').onClick(() => void this.chooseReview(file.path)));
				if (!isSource(file)) return;
				if (file.extension === 'md')
					menu.addItem((i) =>
						i
							.setTitle(this.isReread(file.path) ? 'Stop rereading this note' : 'Reread this note from time to time')
							.setIcon('book-open')
							.onClick(() => void this.toggleReread(file)),
					);
				menu.addItem((i) => i.setTitle('Review the cards of this note').setIcon('layers').onClick(() => void this.reviewNote(file)));
				menu.addItem((i) =>
					i.setTitle('Cards of this note').setIcon('layers').onClick(() => {
						this.lastSource = file;
						void this.openNoteCards();
					}),
				);
			}),
		);
		this.registerEvent(
			this.app.workspace.on('file-open', (f) => {
				if (!isSource(f)) return;
				this.lastSource = f;
				this.redrawNoteCards();
			}),
		);
		this.addRibbonIcon('layers', 'Revisit', () => void this.openPanel());
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				if (!editor.getSelection()) return;
				menu.addItem((i) => i.setTitle('Add to review').setIcon('layers').onClick(() => void this.capture()));
			}),
		);
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('mod-clickable');
		this.statusEl.onclick = () => void this.openPanel();

		this.registerInterval(window.setInterval(() => void this.remind(), 60_000));
		this.app.workspace.onLayoutReady(async () => {
			const active = this.app.workspace.getActiveFile();
			if (isSource(active)) this.lastSource = active;
			await this.reload();
			// a card file edited by hand (or by an agent) is read again
			this.registerEvent(
				this.app.vault.on('modify', (f) => {
					if (f instanceof TFile && f.path.startsWith(this.settings.folder + '/') && f.extension === 'md') void this.reload();
				}),
			);
			// a renamed source note or folder keeps the `Source:` of every card alive
			this.registerEvent(
				this.app.vault.on('rename', (file, oldPath) => {
					const folder = this.settings.folder;
					if (oldPath === folder || oldPath.startsWith(folder + '/')) return;
					if (file instanceof TFolder) void this.rewriteSources(oldPath, file.path, true);
					else if (file instanceof TFile) void this.rewriteSources(oldPath, file.path, false);
				}),
			);
		});
	}

	async loadSettings(): Promise<void> {
		const raw = (await this.loadData()) as Record<string, unknown> | null;
		const { settings, changed } = migrateSettings(raw);
		// before the first migration writes over data.json, the original is copied once
		if (changed) await this.backupDataOnce();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, settings);
		// the FSRS advises against asking for more than 95%
		if (this.settings.retention > 0.95) this.settings.retention = 0.95;
		if (this.settings.retentionImportant > 0.95) this.settings.retentionImportant = 0.95;
		if (changed) await this.saveSettings();
	}

	/** One-time copy of data.json beside the plugin files, before the first settings migration. */
	private async backupDataOnce(): Promise<void> {
		const dir = this.manifest.dir ?? '';
		const target = normalizePath(`${dir}/data.json.backup-pre-migration`);
		if (await this.app.vault.adapter.exists(target)) return;
		const source = normalizePath(`${dir}/data.json`);
		if (await this.app.vault.adapter.exists(source)) await this.app.vault.adapter.write(target, await this.app.vault.adapter.read(source));
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	refreshScheduler(): void {
		this.scheduler = new Scheduler(this.settings.retention, this.settings.retentionImportant);
	}

	private reloading: Promise<void> | null = null;
	async reload(): Promise<void> {
		if (this.reloading) return this.reloading;
		this.reloading = this.store
			.load()
			.catch((e: unknown) => {
				new Notice(`Revisit: error reading the cards (${e instanceof Error ? e.message : String(e)})`);
			})
			.finally(() => {
				this.reloading = null;
				this.updateStatus();
			});
		return this.reloading;
	}

	secs() {
		return secsPerType(this.store.log);
	}

	/** Rewrites the `Source:` of every card file after a source note or folder moved. */
	private async rewriteSources(oldPath: string, newPath: string, folder: boolean): Promise<void> {
		const from = folder ? oldPath.replace(/\/+$/, '') : oldPath.replace(/\.md$/, '');
		const to = folder ? newPath.replace(/\/+$/, '') : newPath.replace(/\.md$/, '');
		for (const f of this.store.cardFiles()) {
			const text = await this.app.vault.cachedRead(f);
			if (!text.includes(from)) continue;
			const next = folder ? renameSourceFolder(text, from, to) : renameSource(text, from, to);
			if (next !== text) await this.app.vault.process(f, () => next);
		}
		await this.reload();
	}

	/** Vault path of the source note or PDF of a card. */
	resolveSource(card: Card): string | null {
		const link = linkPath(card.source);
		if (!link) return null;
		const file = this.app.metadataCache.getFirstLinkpathDest(link, card.file ?? '');
		return file ? file.path : link;
	}

	private itemsCache: { version: number; items: QueueItem[] } | null = null;

	/** One item per card, plus one for its reverse (key `id-r`). Suspending the card suspends both. Memoized until the store changes. */
	items(): QueueItem[] {
		const version = this.store.version;
		if (this.itemsCache && this.itemsCache.version === version) return this.itemsCache.items;
		const out: QueueItem[] = [];
		for (const card of this.store.cards) {
			if (!card.id) continue;
			const source = this.resolveSource(card);
			const suspended = this.store.state[card.id]?.st === 'suspended';
			const holes = card.type === 'Cloze' ? clozes(card.front).length : 0;
			const keys: [string, boolean, number | undefined][] = holes
				? Array.from({ length: holes }, (_, i) => [i ? `${card.id as string}-c${i + 1}` : (card.id as string), false, i])
				: [[card.id, false, undefined]];
			if (card.reverse && !holes) keys.push([`${card.id}-r`, true, undefined]);
			for (const [key, reverse, cloze] of keys) {
				const st = this.store.state[key];
				out.push({ key, reverse, ...(cloze !== undefined ? { cloze } : {}), card, source, ...(st?.fsrs ? { fsrs: fromStored(st.fsrs) } : {}), suspended });
			}
		}
		this.itemsCache = { version, items: out };
		return out;
	}

	/** The card and its siblings (reverse, clozes) are suspended. */
	isSuspended(card: Card): boolean {
		return !!card.id && this.store.state[card.id]?.st === 'suspended';
	}

	/** Keys graded today, outside extra sessions. */
	gradedToday(now = new Date()): Set<string> {
		const day = now.toDateString();
		return new Set(this.store.log.filter((e) => !e.extra && new Date(e.t).toDateString() === day).map((e) => e.id));
	}

	session(scope: string | null, minutes?: number, extra = false, topic: string | null = null): QueueItem[] {
		const now = new Date();
		const items = this.items();
		return buildSession(items, {
			now,
			scope,
			budgetMinutes: minutes ?? this.settings.budgetMinutes,
			newAllowed: this.quota(now, items).free,
			secs: this.secs(),
			interleave: this.settings.interleave,
			retrievability: (c, n) => this.scheduler.retrievability(c, n),
			gradedToday: this.gradedToday(now),
			extra,
			topic,
		});
	}

	/** New cards left today, out of the one daily quota. */
	quota(now = new Date(), items = this.items()): QuotaStatus {
		return quotaStatus({
			dueMinutes: estimateMinutes(dueReviews(items, now), this.secs()),
			budgetMinutes: this.settings.budgetMinutes,
			quota: this.settings.newPerDay,
			used: newToday(this.store.log, now),
		});
	}

	async openPanel(): Promise<void> {
		await this.reload();
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PANEL)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_PANEL, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	private statusTimer: number | null = null;

	/** Debounced: a grade or a settings change touches it, but the recount waits for a quiet moment. */
	updateStatus(): void {
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
		this.statusTimer = window.setTimeout(() => {
			this.statusTimer = null;
			this.updateStatusNow();
		}, 200);
	}

	private updateStatusNow(): void {
		this.redrawNoteCards();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PANEL)) if (leaf.view instanceof PanelView) leaf.view.draw();
		if (!this.statusEl) return;
		const s = this.session(null);
		const n = s.length;
		const newCount = s.filter((it) => isNew(it.fsrs)).length;
		this.statusEl.setText(`Revisit: ${n} ${n === 1 ? 'card' : 'cards'} today${newCount ? ` · ${newCount} new` : ''}`);
	}

	/** "How much time do you have?": the start screen, then the session of that length. */
	async chooseReview(scope: string | null, topic: string | null = null): Promise<void> {
		await this.reload();
		const now = new Date();
		const items = this.items();
		const base = {
			now,
			scope,
			topic,
			newAllowed: this.quota(now, items).free,
			secs: this.secs(),
			interleave: this.settings.interleave,
			retrievability: (c: FsrsCard, n: Date) => this.scheduler.retrievability(c, n),
			gradedToday: this.gradedToday(now),
		};
		const choices = sessionChoices(items, base, this.secs());
		const everything = choices[choices.length - 1];
		if (!everything?.cards) return void new Notice('Revisit: nothing to review now.');
		const name = scope?.split('/').pop()?.replace(/\.md$/, '');
		new StartModal(this.app, {
			title: topic ?? name ?? 'Review',
			choices,
			preselected: nearestChoice(this.settings.budgetMinutes),
			dueCards: everything.cards,
			onStart: (minutes) => void this.review(scope, minutes ?? Number.POSITIVE_INFINITY, false, topic),
		}).open();
	}

	async review(scope: string | null, minutes?: number, extra = false, topic: string | null = null): Promise<void> {
		await this.reload();
		const name = scope?.split('/').pop()?.replace(/\.md$/, '');
		await this.startReview(this.session(scope, minutes, extra, topic), topic ?? name ?? 'All', extra, minutes);
	}

	async startReview(queue: QueueItem[], label: string, extra: boolean, minutes?: number): Promise<void> {
		if (!queue.length) {
			new Notice('Revisit: nothing to review now.');
			return;
		}
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof ReviewView) view.start(queue, label, extra, minutes);
	}

	private pickScope(extra = false): void {
		new ScopeModal(this, extra).open();
	}

	/** Last note or PDF opened, followed by the side panel. */
	lastSource: TFile | null = null;

	/** Cards whose source is this file. */
	cardsOf(file: TFile): Card[] {
		return this.store.cards.filter((c) => c.id && this.resolveSource(c) === file.path);
	}

	redrawNoteCards(): void {
		for (const l of this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE)) if (l.view instanceof NoteCardsView) l.view.draw();
	}

	async openNoteCards(): Promise<void> {
		const active = this.app.workspace.getActiveFile();
		if (!this.lastSource && isSource(active)) this.lastSource = active;
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_NOTE)[0];
		if (!leaf) {
			leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('split');
			await leaf.setViewState({ type: VIEW_TYPE_NOTE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		this.redrawNoteCards();
	}

	/** Every due or new card of one note, outside the daily caps. */
	async reviewNote(file: TFile | null): Promise<void> {
		if (!file) return void new Notice('Revisit: open a note first.');
		await this.reload();
		const now = new Date();
		const items = this.items().filter((it) => this.resolveSource(it.card) === file.path);
		const queue = buildSession(items, {
			now,
			budgetMinutes: 600,
			newAllowed: items.length,
			secs: this.secs(),
			interleave: false,
			retrievability: (c, n) => this.scheduler.retrievability(c, n),
			gradedToday: this.gradedToday(now),
		});
		await this.startReview(queue, file.basename, false);
	}

	topics(): string[] {
		return [...new Set(this.store.cards.flatMap((c) => c.topics))].sort((a, b) => a.localeCompare(b));
	}

	async capture(): Promise<void> {
		const ctx = await captureContext(this.app);
		const selection = ctx?.selection.trim() ?? '';
		const file = ctx?.file ?? null;
		const path = file?.path ?? null;
		// a card whose source is a card file would mirror itself inside the mirror
		if (path && (path === this.settings.folder || path.startsWith(this.settings.folder + '/'))) {
			new Notice('Revisit: the source cannot be a card file of the plugin; open the source note.');
			return;
		}
		const reference = ctx ? bibleReference(ctx.noteText, ctx.cursorLine) : null;
		const type = initialType({ isPdf: !!ctx?.isPdf, hasReference: !!reference, selection });
		const folder = folderOf(path);
		let front = '';
		let back = selection;
		if (type === 'Problem') {
			front = splitAlternatives(selection);
			back = '';
		} else if (type === 'Reference') {
			front = reference ?? '';
		}
		const draft = {
			type,
			front,
			back,
			topic: this.settings.lastTopic[folder] ?? '',
			source: sourceLink(file, ctx?.page ?? null, ctx && !ctx.isPdf ? headingAbove(ctx.noteText, ctx.cursorLine) : null),
			context: ctx?.context ?? '',
			sourcePath: path ?? '',
		};
		new CaptureModal(this.app, draft, this.topics(), 'New card', (r) => this.saveNew(r, path), type === 'Problem').open();
	}

	private async saveNew(r: CaptureResult, sourcePath: string | null): Promise<void> {
		await this.reload();
		const target = mirrorPath(sourcePath, this.settings.folder);
		const id = await this.store.addCard(target, {
			id: null,
			type: r.type,
			front: r.front,
			back: r.back,
			topics: r.topics,
			...(r.reverse ? { reverse: true } : {}),
			source: r.source,
		});
		this.settings.lastTopic[folderOf(sourcePath)] = r.topics.join('; ');
		await this.saveSettings();
		this.updateStatus();
		new Notice(`Revisit: card created${r.topics.length ? ' in ' + r.topics[0] : ''} (^${id})`);
	}

	// ---- rereading whole notes ----

	private rereadKey(path: string): string {
		return `note:${path}`;
	}

	private hasTag(file: TFile): boolean {
		return !!this.settings.rereadTag && noteHasTag(this.app, file, this.settings.rereadTag);
	}

	isReread(path: string): boolean {
		const st = this.store.state[this.rereadKey(path)];
		if (st) return st.st === 'active';
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile && this.hasTag(f);
	}

	/** Every note to reread, with its schedule: marked by command, or carrying the tag. */
	rereadNotes(): { path: string; r?: Reread }[] {
		const paths = new Set<string>();
		for (const [k, v] of Object.entries(this.store.state)) if (k.startsWith('note:') && v.st === 'active') paths.add(k.slice(5));
		if (this.settings.rereadTag) for (const f of this.app.vault.getMarkdownFiles()) if (!f.path.startsWith(this.settings.folder + '/') && this.hasTag(f)) paths.add(f.path);
		return [...paths]
			.filter((p) => this.store.state[this.rereadKey(p)]?.st !== 'suspended' && this.app.vault.getAbstractFileByPath(p))
			.sort()
			.map((path) => {
				const r = this.store.state[this.rereadKey(path)]?.reread;
				return r ? { path, r } : { path };
			});
	}

	dueRereads(now = new Date()): string[] {
		return dueNotes(this.rereadNotes(), now, this.settings.newNotesPerDay);
	}

	async toggleReread(file: TFile | null): Promise<void> {
		if (!file || file.extension !== 'md') return void new Notice('Revisit: open a note first.');
		const key = this.rereadKey(file.path);
		const on = !this.isReread(file.path);
		this.store.state[key] = { ...(this.store.state[key] ?? {}), st: on ? 'active' : 'suspended' };
		await this.store.saveState();
		this.updateStatus();
		new Notice(on ? `Revisit: ${file.basename} enters rereading` : `Revisit: ${file.basename} leaves rereading`);
	}

	/** Note being reread now, shown in the Notes tab of the panel. */
	reading: string | null = null;

	async openNextReread(): Promise<void> {
		await this.reload();
		const next = this.dueRereads()[0];
		if (!next) {
			this.reading = null;
			new Notice('Revisit: no note to reread today.');
		} else {
			await this.openReread(next);
			return;
		}
		this.updateStatus();
	}

	private readLeaf: WorkspaceLeaf | null = null;

	/** Opens a note to reread beside the panel, reusing the same pane each time. */
	async openReread(path: string): Promise<void> {
		this.reading = path;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) {
			const alive = this.readLeaf && this.app.workspace.getLeavesOfType('markdown').includes(this.readLeaf);
			if (!alive) this.readLeaf = this.app.workspace.getLeaf('split', 'vertical');
			await (this.readLeaf as WorkspaceLeaf).openFile(f);
		}
		this.updateStatus();
	}

	async gradeReread(path: string, l: RereadGrade): Promise<void> {
		const key = this.rereadKey(path);
		const prev = this.store.state[key]?.reread;
		this.store.state[key] = { st: 'active', reread: read(prev, l, new Date()) };
		await this.store.saveState();
		new Notice(`Revisit: back at this note in ${daysLabel(this.store.state[key].reread?.days ?? 1)}`);
		await this.openNextReread();
	}

	/** Daily reminder: after the set hour, when cards wait and nothing was reviewed today. */
	private async remind(): Promise<void> {
		const r = this.settings.reminder;
		if (!r) return;
		const now = new Date();
		const [h, m] = r.split(':').map(Number);
		if (now.getHours() * 60 + now.getMinutes() < (h ?? 0) * 60 + (m ?? 0)) return;
		if (this.settings.lastReminder === now.toDateString()) return;
		if (this.gradedToday(now).size) return;
		const n = this.session(null).length;
		if (!n) return;
		this.settings.lastReminder = now.toDateString();
		await this.saveSettings();
		const frag = createFragment();
		frag.createSpan({ text: `Revisit: ${n} ${n === 1 ? 'card waits' : 'cards wait'} for you today. ` });
		const btn = frag.createEl('button', { text: 'Review', cls: 'mod-cta' });
		const notice = new Notice(frag, 0);
		btn.addEventListener('click', () => {
			notice.hide();
			void this.chooseReview(null);
		});
	}

	/** Forgets the schedule of a card (and its reverse): it is new again. */
	async resetCard(card: Card): Promise<void> {
		if (!card.id) return;
		for (const k of Object.keys(this.store.state)) if (k === card.id || k.startsWith(card.id + '-')) delete this.store.state[k];
		await this.store.saveState();
		this.updateStatus();
		new Notice('Revisit: card reset, comes back as new');
	}

	editCard(card: Card, after?: () => void): void {
		if (card.inline) {
			new Notice('Revisit: this card is written in the note; change it there.');
			return;
		}
		const draft = draftFromCard(card, card.file ?? '');
		new CaptureModal(this.app, draft, this.topics(), 'Edit card', async (r) => {
			await this.store.updateCard(card, {
				id: card.id,
				type: r.type,
				front: r.front,
				back: r.back,
				topics: r.topics,
				...(card.tags?.length ? { tags: card.tags } : {}),
				...(r.reverse ? { reverse: true } : {}),
				source: r.source,
			});
			this.updateStatus();
			after?.();
		}).open();
	}

	onunload(): void {
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
		// no ghost leaves of the view types this plugin registered
		for (const t of [VIEW_TYPE_REVIEW, VIEW_TYPE_PANEL, VIEW_TYPE_NOTE]) this.app.workspace.detachLeavesOfType(t);
	}
}

/** Folder of a source path; the key of the last topic used there. */
function folderOf(path: string | null): string {
	return path?.split('/').slice(0, -1).join('/') ?? '';
}

/** Picks what to review: the open note first, then its folders, then every other source. */
class ScopeModal extends SuggestModal<string> {
	constructor(
		private plugin: RevisitPlugin,
		private extra = false,
	) {
		super(plugin.app);
		this.setPlaceholder(extra ? 'Extra session: every card of the note or folder, without changing the schedule' : 'Review a note or a folder');
	}
	getSuggestions(q: string): string[] {
		const active = this.app.workspace.getActiveFile() ?? this.plugin.lastSource;
		const scopes = reviewScopes(this.plugin.items(), active?.path ?? null);
		return scopes.filter((s) => s.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(scope: string, el: HTMLElement): void {
		el.setText(`${scope} · ${this.plugin.session(scope, undefined, this.extra).length}`);
	}
	onChooseSuggestion(scope: string): void {
		if (this.extra) void this.plugin.review(scope, undefined, true);
		else void this.plugin.chooseReview(scope);
	}
}
