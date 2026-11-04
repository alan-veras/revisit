import { getAllTags, Notice, Plugin, SuggestModal, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { areaOf, linkPath } from './cards/area';
import { clozes } from './cards/cloze';
import { daysLabel, dueNotes, RereadGrade, read, Reread } from './notes/reread';
import { mirrorPath } from './cards/mirror';
import { AREAS, Card } from './cards/types';
import { bibleReference, initialType, splitAlternatives } from './capture/autoType';
import { CaptureModal, CaptureResult, draftFromCard } from './capture/CaptureModal';
import { captureContext, headingAbove, sourceLink } from './capture/selection';
import { renameSource, renameSourceFolder } from './cards/format';
import { ReviewView, VIEW_TYPE_REVIEW } from './review/ReviewView';
import { DEFAULT_SETTINGS, RevisitSettings, RevisitSettingTab } from './settings';
import { newTodayByArea, QuotaStatus, quotaStatus, secsPerType } from './srs/budget';
import { buildSession, dueReviews, estimateMinutes, NO_AREA, QueueItem } from './srs/queue';
import { fromStored, isNew, Scheduler } from './srs/scheduler';
import { Store } from './store/Store';
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
		this.store = new Store(this.app, () => this.settings.folder);
		this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));
		this.registerView(VIEW_TYPE_PANEL, (leaf: WorkspaceLeaf) => new PanelView(leaf, this));
		this.addCommand({ id: 'open-painel', name: 'Abrir painel', callback: () => void this.openPainel() });
		this.addSettingTab(new RevisitSettingTab(this.app, this));
		registerCli(this);

		this.addCommand({ id: 'capture', name: 'Adicionar à revisão', callback: () => void this.capture() });
		this.addCommand({ id: 'review', name: 'Revisar', callback: () => void this.review(null) });
		this.addCommand({ id: 'review-area', name: 'Revisar uma área', callback: () => this.pickArea() });
		this.addCommand({ id: 'review-extra', name: 'Sessão extra antes da prova', callback: () => this.pickArea(true) });
		this.addCommand({ id: 'reread-toggle', name: 'Reler esta grade de tempos em tempos (liga ou desliga)', callback: () => void this.toggleReread(this.app.workspace.getActiveFile()) });
		this.addCommand({ id: 'reread-next', name: 'Reler a próxima grade', callback: () => void this.openNextReread() });
		this.addCommand({ id: 'note-cards', name: 'Cartões desta grade', callback: () => void this.openNoteCards() });
		this.addCommand({ id: 'review-note', name: 'Revisar os cartões desta grade', callback: () => void this.reviewNote(this.app.workspace.getActiveFile() ?? this.lastSource) });
		this.registerView(VIEW_TYPE_NOTE, (leaf: WorkspaceLeaf) => new NoteCardsView(leaf, this));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!isSource(file)) return;
				if (file.extension === 'md')
					menu.addItem((i) =>
						i
							.setTitle(this.isReread(file.path) ? 'Parar de reler esta grade' : 'Reler esta grade de tempos em tempos')
							.setIcon('book-open')
							.onClick(() => void this.toggleReread(file)),
					);
				menu.addItem((i) => i.setTitle('Revisar os cartões desta grade').setIcon('layers').onClick(() => void this.reviewNote(file)));
				menu.addItem((i) =>
					i.setTitle('Cartões desta grade').setIcon('layers').onClick(() => {
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
		this.addRibbonIcon('layers', 'Lembro', () => void this.openPainel());
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				if (!editor.getSelection()) return;
				menu.addItem((i) => i.setTitle('Adicionar à revisão').setIcon('layers').onClick(() => void this.capture()));
			}),
		);
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('mod-clickable');
		this.statusEl.onclick = () => void this.openPainel();

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
			// a renamed source note or folder keeps the `Fonte:` of every card alive
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<RevisitSettings> | null);
		// the general cap is gone: each area has its own quota
		delete (this.settings as Partial<RevisitSettings> & { newPerDay?: number }).newPerDay;
		// the FSRS advises against asking for more than 95%
		if (this.settings.retention > 0.95) this.settings.retention = 0.95;
		if (this.settings.retentionImportant > 0.95) this.settings.retentionImportant = 0.95;
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
				new Notice(`Lembro: erro ao ler os cartões (${e instanceof Error ? e.message : String(e)})`);
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

	/** Rewrites the `Fonte:` of every card file after a source note or folder moved. */
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

	/** Área of a card: the one written in it, or the one of its source path. */
	areaOfCard(card: Card): string | null {
		if (card.area) return card.area;
		const target = this.resolveSource(card);
		return target ? areaOf(target, this.settings.areaMap) : null;
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
			const area = this.areaOfCard(card);
			const suspended = this.store.state[card.id]?.st === 'suspended';
			const holes = card.type === 'Lacuna' ? clozes(card.front).length : 0;
			const keys: [string, boolean, number | undefined][] = holes
				? Array.from({ length: holes }, (_, i) => [i ? `${card.id as string}-c${i + 1}` : (card.id as string), false, i])
				: [[card.id, false, undefined]];
			if (card.reverse && !holes) keys.push([`${card.id}-r`, true, undefined]);
			for (const [key, reverse, cloze] of keys) {
				const st = this.store.state[key];
				out.push({ key, reverse, ...(cloze !== undefined ? { cloze } : {}), card, area, ...(st?.fsrs ? { fsrs: fromStored(st.fsrs) } : {}), suspended });
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

	session(area: string | null, minutes?: number, extra = false, topic: string | null = null): QueueItem[] {
		const now = new Date();
		const items = this.items();
		const secs = this.secs();
		const budget = minutes ?? this.settings.budgetMinutes;
		const q = this.quota(now, items);
		return buildSession(items, {
			now,
			area,
			budgetMinutes: budget,
			newAllowed: q.total.free,
			newLeftByArea: new Map(q.areas.map((a) => [a.area, a.free])),
			secs,
			interleave: this.settings.interleave,
			retrievability: (c, n) => this.scheduler.retrievability(c, n),
			gradedToday: this.gradedToday(now),
			extra,
			topic,
		});
	}

	/** New cards left today in each area (its quota comes from the settings, 5 by default). */
	quota(now = new Date(), items = this.items()): QuotaStatus {
		const areaById = new Map<string, string>();
		for (const it of items) areaById.set(it.key, it.area ?? NO_AREA);
		return quotaStatus({
			dueMinutes: estimateMinutes(dueReviews(items, now), this.secs()),
			budgetMinutes: this.settings.budgetMinutes,
			areas: [...AREAS, NO_AREA],
			perArea: this.settings.newPerArea,
			usedByArea: newTodayByArea(this.store.log, now, (id) => areaById.get(id) ?? null),
		});
	}

	async openPainel(): Promise<void> {
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
		this.statusEl.setText(`Lembro: ${n} ${n === 1 ? 'cabe' : 'fit'} hoje${newCount ? ` · ${newCount} ${newCount === 1 ? 'new' : 'novos'}` : ''}`);
	}

	async review(area: string | null, minutes?: number, extra = false, topic: string | null = null): Promise<void> {
		await this.reload();
		await this.startReview(this.session(area, minutes, extra, topic), topic ? `${area ?? 'Tudo'} > ${topic}` : (area ?? 'Tudo'), extra);
	}

	async startReview(queue: QueueItem[], label: string, extra: boolean): Promise<void> {
		if (!queue.length) {
			new Notice('Lembro: nada para revisar agora.');
			return;
		}
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof ReviewView) view.start(queue, label, extra);
	}

	private pickArea(extra = false): void {
		new AreaModal(this, extra).open();
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
		if (!file) return void new Notice('Lembro: abra uma grade primeiro.');
		await this.reload();
		const now = new Date();
		const items = this.items().filter((it) => this.resolveSource(it.card) === file.path);
		const queue = buildSession(items, {
			now,
			area: null,
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
		return [...new Set(this.store.cards.flatMap((c) => c.topics))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
	}

	async capture(): Promise<void> {
		const ctx = await captureContext(this.app);
		const selection = ctx?.selection.trim() ?? '';
		const file = ctx?.file ?? null;
		const path = file?.path ?? null;
		// a card whose source is a card file would mirror itself inside the mirror
		if (path && (path === this.settings.folder || path.startsWith(this.settings.folder + '/'))) {
			new Notice('Lembro: a source não pode ser um arquivo de cartões do plugin; abra a grade de origem.');
			return;
		}
		const type = initialType({ isPdf: !!ctx?.isPdf, path, selection });
		const area = (path && areaOf(path, this.settings.areaMap)) ?? '';
		let front = '';
		let back = selection;
		if (type === 'Questão') {
			front = splitAlternatives(selection);
			back = '';
		} else if (type === 'Referência' && ctx) {
			front = bibleReference(ctx.noteText, ctx.cursorLine) ?? '';
		}
		const draft = {
			type,
			front,
			back,
			area: area || (this.settings.lastTopic['__area'] ?? AREAS[0]),
			topic: (area && this.settings.lastTopic[area]) ?? '',
			source: sourceLink(file, ctx?.page ?? null, ctx && !ctx.isPdf ? headingAbove(ctx.noteText, ctx.cursorLine) : null),
			context: ctx?.context ?? '',
			sourcePath: path ?? '',
		};
		new CaptureModal(this.app, draft, this.topics(), 'Novo cartão', (r) => this.saveNew(r, path, area), type === 'Questão').open();
	}

	private async saveNew(r: CaptureResult, sourcePath: string | null, derivedArea: string): Promise<void> {
		await this.reload();
		const target = mirrorPath(sourcePath, this.settings.folder);
		const id = await this.store.addCard(target, {
			id: null,
			type: r.type,
			front: r.front,
			back: r.back,
			...(r.area && r.area !== derivedArea ? { area: r.area } : {}),
			topics: r.topics,
			...(r.reverse ? { reverse: true } : {}),
			source: r.source,
		});
		this.settings.lastTopic[r.area] = r.topics.join('; ');
		this.settings.lastTopic['__area'] = r.area;
		await this.saveSettings();
		this.updateStatus();
		new Notice(`Lembro: cartão criado em ${r.area}${r.topics.length ? ' > ' + r.topics[0] : ''} (^${id})`);
	}

	// ---- reread de notas inteiras ----

	private rereadKey(path: string): string {
		return `note:${path}`;
	}

	private hasTag(file: TFile): boolean {
		const tag = this.settings.rereadTag.toLowerCase();
		if (!tag) return false;
		const cache = this.app.metadataCache.getFileCache(file);
		return !!cache && (getAllTags(cache) ?? []).some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
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
		if (!file || file.extension !== 'md') return void new Notice('Lembro: abra uma grade primeiro.');
		const key = this.rereadKey(file.path);
		const on = !this.isReread(file.path);
		this.store.state[key] = { ...(this.store.state[key] ?? {}), st: on ? 'active' : 'suspended' };
		await this.store.saveState();
		this.updateStatus();
		new Notice(on ? `Lembro: ${file.basename} entra na reread` : `Lembro: ${file.basename} sai da reread`);
	}

	/** Note being reread now, shown in the Notas tab of the painel. */
	reading: string | null = null;

	async openNextReread(): Promise<void> {
		await this.reload();
		const next = this.dueRereads()[0];
		if (!next) {
			this.reading = null;
			new Notice('Lembro: nenhuma grade para reler hoje.');
		} else {
			await this.openReread(next);
			return;
		}
		this.updateStatus();
	}

	private readLeaf: WorkspaceLeaf | null = null;

	/** Opens a note to reread beside the painel, reusing the same pane each time. */
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
		new Notice(`Lembro: volta a esta grade em ${daysLabel(this.store.state[key].reread?.days ?? 1)}`);
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
		frag.createSpan({ text: `Lembro: ${n} ${n === 1 ? 'cartão espera' : 'cartões esperam'} por você hoje. ` });
		const btn = frag.createEl('button', { text: 'Revisar', cls: 'mod-cta' });
		const notice = new Notice(frag, 0);
		btn.addEventListener('click', () => {
			notice.hide();
			void this.review(null);
		});
	}

	/** Forgets the schedule of a card (and its reverse): it is new again. */
	async resetCard(card: Card): Promise<void> {
		if (!card.id) return;
		for (const k of Object.keys(this.store.state)) if (k === card.id || k.startsWith(card.id + '-')) delete this.store.state[k];
		await this.store.saveState();
		this.updateStatus();
		new Notice('Lembro: cartão recomeçado, volta como new');
	}

	editCard(card: Card, after?: () => void): void {
		const derived = (() => {
			const t = this.resolveSource(card);
			return t ? areaOf(t, this.settings.areaMap) : null;
		})();
		const area = card.area ?? derived ?? AREAS[0];
		const draft = draftFromCard(card, area, card.file ?? '');
		new CaptureModal(this.app, draft, this.topics(), 'Editar cartão', async (r) => {
			await this.store.updateCard(card, {
				id: card.id,
				type: r.type,
				front: r.front,
				back: r.back,
				...(r.area && r.area !== derived ? { area: r.area } : {}),
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


class AreaModal extends SuggestModal<string> {
	constructor(
		private plugin: RevisitPlugin,
		private extra = false,
	) {
		super(plugin.app);
		if (extra) this.setPlaceholder('Sessão extra: all os cartões da área, sem mudar a agenda');
	}
	getSuggestions(q: string): string[] {
		return AREAS.filter((a) => a.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(a: string, el: HTMLElement): void {
		el.setText(`${a} · ${this.plugin.session(a, undefined, this.extra).length}`);
	}
	onChooseSuggestion(a: string): void {
		void this.plugin.review(a, undefined, this.extra);
	}
}
