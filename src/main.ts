import { MarkdownView, normalizePath, Notice, Plugin, TFile, WorkspaceLeaf } from 'obsidian';
import { buildItems, buildQueue } from './core/queue';
import { Scheduler } from './core/scheduler';
import type { Card } from './core/types';
import { sourceLink } from './core/format';
import { Store } from './store/store';
import { DEFAULT_SETTINGS, RevisitSettings, RevisitSettingTab } from './settings';
import { CreateModal, Draft } from './ui/CreateModal';
import { ReviewView, VIEW_TYPE_REVIEW } from './ui/ReviewView';

export default class RevisitPlugin extends Plugin {
	settings: RevisitSettings = { ...DEFAULT_SETTINGS };
	store!: Store;
	scheduler!: Scheduler;
	/** data.json as read, so keys of older versions survive a save */
	private rawData: Record<string, unknown> = {};
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		this.rawData = ((await this.loadData()) as Record<string, unknown> | null) ?? {};
		const folder = typeof this.rawData.folder === 'string' && this.rawData.folder ? this.rawData.folder : DEFAULT_SETTINGS.folder;
		const retention = Number(this.rawData.retention);
		this.settings = { folder, retention: retention >= 0.7 && retention <= 0.95 ? retention : DEFAULT_SETTINGS.retention };
		this.scheduler = new Scheduler(this.settings.retention);
		this.store = new Store(this.app, () => this.settings.folder);

		this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));
		this.addSettingTab(new RevisitSettingTab(this.app, this));
		this.addRibbonIcon('layers', 'Revisit', () => void this.openReview());
		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass('mod-clickable');
		this.statusEl.onclick = () => void this.openReview();

		this.addCommand({ id: 'review', name: 'Review', callback: () => void this.openReview() });
		this.addCommand({ id: 'new-card', name: 'New card', callback: () => void this.createFromEditor() });
		this.registerEvent(
			this.app.workspace.on('editor-menu', (menu, editor) => {
				const title = editor.getSelection() ? 'New card from selection' : 'New card';
				menu.addItem((i) => i.setTitle(title).setIcon('layers').onClick(() => void this.createFromEditor()));
			}),
		);
		this.app.workspace.onLayoutReady(() => {
			void this.refresh();
			// a card file edited by hand is read again
			this.registerEvent(
				this.app.vault.on('modify', (f) => {
					if (f instanceof TFile && f.path.startsWith(normalizePath(this.settings.folder) + '/') && f.extension === 'md') void this.store.loadCards().then(() => this.updateStatus());
				}),
			);
		});
	}

	async saveSettings(): Promise<void> {
		this.scheduler = new Scheduler(this.settings.retention);
		await this.saveData({ ...this.rawData, ...this.settings });
		await this.refresh();
	}

	async refresh(): Promise<void> {
		await this.store.load();
		this.updateStatus();
	}

	updateStatus(): void {
		if (!this.statusEl) return;
		const items = buildItems(this.store.cards, this.store.state);
		const n = buildQueue(items, { now: new Date(), log: this.store.log, retrievability: (c, now) => this.scheduler.retrievability(c, now) }).length;
		this.statusEl.setText(n ? `Revisit: ${n}` : 'Revisit');
	}

	async openReview(): Promise<void> {
		const { workspace } = this.app;
		const open = workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
		const leaf = open ?? workspace.getLeaf('tab');
		// a new view starts itself when it opens; one already open goes back to Start, unless a session is running
		if (!open) await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
		else if (open.view instanceof ReviewView && !open.view.reviewing) await open.view.begin();
		await workspace.revealLeaf(leaf);
	}

	/** The create window: a new card, or the edit of `card`. */
	openCreate(o: { card?: Card; draft?: Partial<Draft>; onSaved?: () => void }): void {
		const { card } = o;
		const draft: Draft = { front: card?.front ?? '', back: card?.back ?? '', topics: card?.topics ?? [], source: card?.source ?? '', context: '', ...(card ? { card } : {}), ...o.draft };
		new CreateModal(this.app, draft, async (r) => {
			// editing keeps the type of kinds the UI no longer offers (Reference, Problem)
			const type = card && card.type !== 'Question' && card.type !== 'Cloze' ? card.type : r.type;
			const fields = { type, front: r.front, back: r.back, topics: draft.topics, source: draft.source };
			if (card) await this.store.updateCard(card, { ...card, ...fields, id: card.id });
			else {
				const id = await this.store.addCard({ id: null, ...fields });
				new Notice(`Revisit: card created (^${id})`);
			}
			this.updateStatus();
			o.onSaved?.();
		}).open();
	}

	/** A new card from the active note: the selection goes to Back, the area comes from the note's folder. */
	private createFromEditor(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const file = view?.file ?? null;
		if (file && file.path.startsWith(this.settings.folder + '/')) {
			new Notice('Revisit: open the source note, not a card file.');
			return;
		}
		const editor = view?.editor;
		const selection = editor?.getSelection().trim() ?? '';
		const from = editor?.getCursor('from');
		const to = editor?.getCursor('to');
		const context = editor && from && to ? Array.from({ length: to.line - from.line + 1 }, (_, i) => editor.getLine(from.line + i)).join('\n') : '';
		const area = file?.parent && !file.parent.isRoot() ? file.parent.name : '';
		this.openCreate({ draft: { back: selection, context, topics: area ? [area] : [], source: sourceLink(file?.path ?? null) } });
	}
}
