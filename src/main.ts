import { getAllTags, Notice, Plugin, SuggestModal, TFile, TFolder, WorkspaceLeaf } from 'obsidian';
import { areaOf, linkPath } from './cards/area';
import { clozes } from './cards/cloze';
import { daysLabel, dueNotes, Leitura, read, Releitura } from './notes/reread';
import { mirrorPath } from './cards/mirror';
import { AREAS, Card } from './cards/types';
import { bibleReference, initialType, splitAlternatives } from './capture/autoType';
import { CaptureModal, CaptureResult, draftFromCard } from './capture/CaptureModal';
import { captureContext, headingAbove, sourceLink } from './capture/selection';
import { renameSource, renameSourceFolder } from './cards/format';
import { ReviewView, VIEW_TYPE_REVIEW } from './review/ReviewView';
import { DEFAULT_SETTINGS, LembroSettings, LembroSettingTab } from './settings';
import { newTodayByArea, QuotaStatus, quotaStatus, secsPerType } from './srs/budget';
import { buildSession, dueReviews, estimateMinutes, NO_AREA, QueueItem } from './srs/queue';
import { fromStored, isNew, Scheduler } from './srs/scheduler';
import { Store } from './store/Store';
import { PainelView, VIEW_TYPE_PAINEL } from './view/PainelView';
import { isSource, NoteCardsView, VIEW_TYPE_NOTE } from './view/NoteCardsView';
import { registerCli } from './cli/commands';

export default class LembroPlugin extends Plugin {
	settings: LembroSettings = DEFAULT_SETTINGS;
	store!: Store;
	scheduler!: Scheduler;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.scheduler = new Scheduler(this.settings.retention, this.settings.retentionImportant);
		this.store = new Store(this.app, () => this.settings.folder);
		this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));
		this.registerView(VIEW_TYPE_PAINEL, (leaf: WorkspaceLeaf) => new PainelView(leaf, this));
		this.addCommand({ id: 'open-painel', name: 'Abrir painel', callback: () => void this.openPainel() });
		this.addSettingTab(new LembroSettingTab(this.app, this));
		registerCli(this);

		this.addCommand({ id: 'capture', name: 'Adicionar à revisão', callback: () => void this.capture() });
		this.addCommand({ id: 'review', name: 'Revisar', callback: () => void this.review(null) });
		this.addCommand({ id: 'review-area', name: 'Revisar uma área', callback: () => this.pickArea() });
		this.addCommand({ id: 'review-extra', name: 'Sessão extra antes da prova', callback: () => this.pickArea(true) });
		this.addCommand({ id: 'reread-toggle', name: 'Reler esta nota de tempos em tempos (liga ou desliga)', callback: () => void this.toggleReread(this.app.workspace.getActiveFile()) });
		this.addCommand({ id: 'reread-next', name: 'Reler a próxima nota', callback: () => void this.openNextReread() });
		this.addCommand({ id: 'note-cards', name: 'Cartões desta nota', callback: () => void this.openNoteCards() });
		this.addCommand({ id: 'review-note', name: 'Revisar os cartões desta nota', callback: () => void this.reviewNote(this.app.workspace.getActiveFile() ?? this.lastSource) });
		this.registerView(VIEW_TYPE_NOTE, (leaf: WorkspaceLeaf) => new NoteCardsView(leaf, this));
		this.registerEvent(
			this.app.workspace.on('file-menu', (menu, file) => {
				if (!isSource(file)) return;
				if (file.extension === 'md')
					menu.addItem((i) =>
						i
							.setTitle(this.isReread(file.path) ? 'Parar de reler esta nota' : 'Reler esta nota de tempos em tempos')
							.setIcon('book-open')
							.onClick(() => void this.toggleReread(file)),
					);
				menu.addItem((i) => i.setTitle('Revisar os cartões desta nota').setIcon('layers').onClick(() => void this.reviewNote(file)));
				menu.addItem((i) =>
					i.setTitle('Cartões desta nota').setIcon('layers').onClick(() => {
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<LembroSettings> | null);
		// the general cap is gone: each area has its own cota
		delete (this.settings as Partial<LembroSettings> & { newPerDay?: number }).newPerDay;
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
		const link = linkPath(card.fonte);
		if (!link) return null;
		const file = this.app.metadataCache.getFirstLinkpathDest(link, card.file ?? '');
		return file ? file.path : link;
	}

	/** One item per card, plus one for its reverse (key `id-r`). Suspending the card suspends both. */
	items(): QueueItem[] {
		const out: QueueItem[] = [];
		for (const card of this.store.cards) {
			if (!card.id) continue;
			const area = this.areaOfCard(card);
			const suspended = this.store.state[card.id]?.st === 'suspenso';
			const holes = card.tipo === 'Lacuna' ? clozes(card.frente).length : 0;
			const keys: [string, boolean, number | undefined][] = holes
				? Array.from({ length: holes }, (_, i) => [i ? `${card.id as string}-c${i + 1}` : (card.id as string), false, i])
				: [[card.id, false, undefined]];
			if (card.reverso && !holes) keys.push([`${card.id}-r`, true, undefined]);
			for (const [key, reverso, cloze] of keys) {
				const st = this.store.state[key];
				out.push({ key, reverso, ...(cloze !== undefined ? { cloze } : {}), card, area, ...(st?.fsrs ? { fsrs: fromStored(st.fsrs) } : {}), suspended });
			}
		}
		return out;
	}

	/** Keys graded today, outside extra sessions. */
	gradedToday(now = new Date()): Set<string> {
		const day = now.toDateString();
		return new Set(this.store.log.filter((e) => !e.extra && new Date(e.t).toDateString() === day).map((e) => e.id));
	}

	session(area: string | null, minutes?: number, extra = false, assunto: string | null = null): QueueItem[] {
		const now = new Date();
		const items = this.items();
		const secs = this.secs();
		const budget = minutes ?? this.settings.budgetMinutes;
		const q = this.quota(now, items);
		return buildSession(items, {
			now,
			area,
			budgetMinutes: budget,
			newAllowed: q.total.livres,
			newLeftByArea: new Map(q.areas.map((a) => [a.area, a.livres])),
			secs,
			interleave: this.settings.interleave,
			retrievability: (c, n) => this.scheduler.retrievability(c, n),
			gradedToday: this.gradedToday(now),
			extra,
			assunto,
		});
	}

	/** New cards left today in each area (its cota comes from the settings, 5 by default). */
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
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_PAINEL)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_PAINEL, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	updateStatus(): void {
		this.redrawNoteCards();
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PAINEL)) if (leaf.view instanceof PainelView) leaf.view.draw();
		if (!this.statusEl) return;
		const s = this.session(null);
		const n = s.length;
		const novos = s.filter((it) => isNew(it.fsrs)).length;
		this.statusEl.setText(`Lembro: ${n} ${n === 1 ? 'cabe' : 'cabem'} hoje${novos ? ` · ${novos} ${novos === 1 ? 'novo' : 'novos'}` : ''}`);
	}

	async review(area: string | null, minutes?: number, extra = false, assunto: string | null = null): Promise<void> {
		await this.reload();
		await this.startReview(this.session(area, minutes, extra, assunto), assunto ? `${area ?? 'Tudo'} > ${assunto}` : (area ?? 'Tudo'), extra);
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
		if (!file) return void new Notice('Lembro: abra uma nota primeiro.');
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

	assuntos(): string[] {
		return [...new Set(this.store.cards.flatMap((c) => c.assuntos))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
	}

	async capture(): Promise<void> {
		const ctx = await captureContext(this.app);
		const selection = ctx?.selection.trim() ?? '';
		const file = ctx?.file ?? null;
		const path = file?.path ?? null;
		const tipo = initialType({ isPdf: !!ctx?.isPdf, path, selection });
		const area = (path && areaOf(path, this.settings.areaMap)) ?? '';
		let frente = '';
		let verso = selection;
		if (tipo === 'Questão') {
			frente = splitAlternatives(selection);
			verso = '';
		} else if (tipo === 'Referência' && ctx) {
			frente = bibleReference(ctx.noteText, ctx.cursorLine) ?? '';
		}
		const draft = {
			tipo,
			frente,
			verso,
			area: area || (this.settings.lastAssunto['__area'] ?? AREAS[0]),
			assunto: (area && this.settings.lastAssunto[area]) ?? '',
			fonte: sourceLink(file, ctx?.page ?? null, ctx && !ctx.isPdf ? headingAbove(ctx.noteText, ctx.cursorLine) : null),
			context: ctx?.context ?? '',
			sourcePath: path ?? '',
		};
		new CaptureModal(this.app, draft, this.assuntos(), 'Novo cartão', (r) => this.saveNew(r, path, area), tipo === 'Questão').open();
	}

	private async saveNew(r: CaptureResult, sourcePath: string | null, derivedArea: string): Promise<void> {
		await this.reload();
		const target = mirrorPath(sourcePath, this.settings.folder);
		const id = await this.store.addCard(target, {
			id: null,
			tipo: r.tipo,
			frente: r.frente,
			verso: r.verso,
			...(r.area && r.area !== derivedArea ? { area: r.area } : {}),
			assuntos: r.assuntos,
			...(r.reverso ? { reverso: true } : {}),
			fonte: r.fonte,
		});
		this.settings.lastAssunto[r.area] = r.assuntos.join('; ');
		this.settings.lastAssunto['__area'] = r.area;
		await this.saveSettings();
		this.updateStatus();
		new Notice(`Lembro: cartão criado em ${r.area}${r.assuntos.length ? ' > ' + r.assuntos[0] : ''} (^${id})`);
	}

	// ---- releitura de notas inteiras ----

	private rereadKey(path: string): string {
		return `nota:${path}`;
	}

	private hasTag(file: TFile): boolean {
		const tag = this.settings.rereadTag.toLowerCase();
		if (!tag) return false;
		const cache = this.app.metadataCache.getFileCache(file);
		return !!cache && (getAllTags(cache) ?? []).some((t) => t.toLowerCase() === tag || t.toLowerCase().startsWith(tag + '/'));
	}

	isReread(path: string): boolean {
		const st = this.store.state[this.rereadKey(path)];
		if (st) return st.st === 'ativo';
		const f = this.app.vault.getAbstractFileByPath(path);
		return f instanceof TFile && this.hasTag(f);
	}

	/** Every note to reread, with its schedule: marked by command, or carrying the tag. */
	rereadNotes(): { path: string; r?: Releitura }[] {
		const paths = new Set<string>();
		for (const [k, v] of Object.entries(this.store.state)) if (k.startsWith('nota:') && v.st === 'ativo') paths.add(k.slice(5));
		if (this.settings.rereadTag) for (const f of this.app.vault.getMarkdownFiles()) if (!f.path.startsWith(this.settings.folder + '/') && this.hasTag(f)) paths.add(f.path);
		return [...paths]
			.filter((p) => this.store.state[this.rereadKey(p)]?.st !== 'suspenso' && this.app.vault.getAbstractFileByPath(p))
			.sort()
			.map((path) => {
				const r = this.store.state[this.rereadKey(path)]?.releitura;
				return r ? { path, r } : { path };
			});
	}

	dueRereads(now = new Date()): string[] {
		return dueNotes(this.rereadNotes(), now, this.settings.newNotesPerDay);
	}

	async toggleReread(file: TFile | null): Promise<void> {
		if (!file || file.extension !== 'md') return void new Notice('Lembro: abra uma nota primeiro.');
		const key = this.rereadKey(file.path);
		const on = !this.isReread(file.path);
		this.store.state[key] = { ...(this.store.state[key] ?? {}), st: on ? 'ativo' : 'suspenso' };
		await this.store.saveState();
		this.updateStatus();
		new Notice(on ? `Lembro: ${file.basename} entra na releitura` : `Lembro: ${file.basename} sai da releitura`);
	}

	/** Note being reread now, shown in the Notas tab of the painel. */
	reading: string | null = null;

	async openNextReread(): Promise<void> {
		await this.reload();
		const next = this.dueRereads()[0];
		if (!next) {
			this.reading = null;
			new Notice('Lembro: nenhuma nota para reler hoje.');
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

	async gradeReread(path: string, l: Leitura): Promise<void> {
		const key = this.rereadKey(path);
		const prev = this.store.state[key]?.releitura;
		this.store.state[key] = { st: 'ativo', releitura: read(prev, l, new Date()) };
		await this.store.saveState();
		new Notice(`Lembro: volta a esta nota em ${daysLabel(this.store.state[key].releitura?.dias ?? 1)}`);
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
		new Notice('Lembro: cartão recomeçado, volta como novo');
	}

	editCard(card: Card, after?: () => void): void {
		const derived = (() => {
			const t = this.resolveSource(card);
			return t ? areaOf(t, this.settings.areaMap) : null;
		})();
		const area = card.area ?? derived ?? AREAS[0];
		const draft = draftFromCard(card, area, card.file ?? '');
		new CaptureModal(this.app, draft, this.assuntos(), 'Editar cartão', async (r) => {
			await this.store.updateCard(card, {
				id: card.id,
				tipo: r.tipo,
				frente: r.frente,
				verso: r.verso,
				...(r.area && r.area !== derived ? { area: r.area } : {}),
				assuntos: r.assuntos,
				...(card.tags?.length ? { tags: card.tags } : {}),
				...(r.reverso ? { reverso: true } : {}),
				fonte: r.fonte,
			});
			this.updateStatus();
			after?.();
		}).open();
	}

	onunload(): void {
		// views are detached by Obsidian
	}
}


class AreaModal extends SuggestModal<string> {
	constructor(
		private plugin: LembroPlugin,
		private extra = false,
	) {
		super(plugin.app);
		if (extra) this.setPlaceholder('Sessão extra: todos os cartões da área, sem mudar a agenda');
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
