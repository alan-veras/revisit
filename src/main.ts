import { Notice, Plugin, SuggestModal, TFile, WorkspaceLeaf } from 'obsidian';
import { areaOf, linkPath } from './cards/area';
import { mirrorPath } from './cards/mirror';
import { AREAS, Card } from './cards/types';
import { bibleReference, initialType, splitAlternatives } from './capture/autoType';
import { CaptureModal, CaptureResult, draftFromCard } from './capture/CaptureModal';
import { captureContext, sourceLink } from './capture/selection';
import { ReviewView, VIEW_TYPE_REVIEW } from './review/ReviewView';
import { DEFAULT_SETTINGS, LembroSettings, LembroSettingTab } from './settings';
import { newAllowedToday, newToday, secsPerType } from './srs/budget';
import { buildSession, dueReviews, estimateMinutes, QueueItem } from './srs/queue';
import { fromStored, Scheduler } from './srs/scheduler';
import { Store } from './store/Store';
import { PainelView, VIEW_TYPE_PAINEL } from './view/PainelView';

export default class LembroPlugin extends Plugin {
	settings: LembroSettings = DEFAULT_SETTINGS;
	store!: Store;
	scheduler!: Scheduler;
	private statusEl: HTMLElement | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.scheduler = new Scheduler(this.settings.retention);
		this.store = new Store(this.app, () => this.settings.folder);
		this.registerView(VIEW_TYPE_REVIEW, (leaf: WorkspaceLeaf) => new ReviewView(leaf, this));
		this.registerView(VIEW_TYPE_PAINEL, (leaf: WorkspaceLeaf) => new PainelView(leaf, this));
		this.addCommand({ id: 'open-painel', name: 'Abrir painel', callback: () => void this.openPainel() });
		this.addSettingTab(new LembroSettingTab(this.app, this));

		this.addCommand({ id: 'capture', name: 'Adicionar à revisão', callback: () => void this.capture() });
		this.addCommand({ id: 'review', name: 'Revisar', callback: () => void this.review(null) });
		this.addCommand({ id: 'review-area', name: 'Revisar uma área', callback: () => this.pickArea() });
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

		this.app.workspace.onLayoutReady(async () => {
			await this.reload();
			// a card file edited by hand (or by an agent) is read again
			this.registerEvent(
				this.app.vault.on('modify', (f) => {
					if (f instanceof TFile && f.path.startsWith(this.settings.folder + '/') && f.extension === 'md') void this.reload();
				}),
			);
		});
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<LembroSettings> | null);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	refreshScheduler(): void {
		this.scheduler = new Scheduler(this.settings.retention);
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

	items(): QueueItem[] {
		return this.store.cards
			.filter((c) => c.id)
			.map((card) => {
				const st = this.store.state[card.id as string];
				return {
					card,
					area: this.areaOfCard(card),
					...(st?.fsrs ? { fsrs: fromStored(st.fsrs) } : {}),
					suspended: st?.st === 'suspenso',
				};
			});
	}

	session(area: string | null, minutes?: number): QueueItem[] {
		const now = new Date();
		const items = this.items();
		const secs = this.secs();
		const budget = minutes ?? this.settings.budgetMinutes;
		const due = dueReviews(items, now);
		const allowed = Math.max(0, newAllowedToday(estimateMinutes(due, secs), this.settings.budgetMinutes, this.settings.newPerDay) - newToday(this.store.log, now));
		return buildSession(items, {
			now,
			area,
			budgetMinutes: budget,
			newAllowed: allowed,
			secs,
			interleave: this.settings.interleave,
			retrievability: (c, n) => this.scheduler.retrievability(c, n),
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
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_PAINEL)) if (leaf.view instanceof PainelView) leaf.view.draw();
		if (!this.statusEl) return;
		const n = this.session(null).length;
		this.statusEl.setText(`Lembro: ${n} ${n === 1 ? 'cabe' : 'cabem'} hoje`);
	}

	async review(area: string | null, minutes?: number): Promise<void> {
		await this.reload();
		const queue = this.session(area, minutes);
		let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_REVIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeaf('tab');
			await leaf.setViewState({ type: VIEW_TYPE_REVIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		const view = leaf.view;
		if (view instanceof ReviewView) view.start(queue, area ?? 'Tudo');
		if (!queue.length) new Notice('Lembro: nada para revisar agora.');
	}

	private pickArea(): void {
		new AreaModal(this).open();
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
			fonte: sourceLink(file, ctx?.page ?? null),
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
			fonte: r.fonte,
		});
		this.settings.lastAssunto[r.area] = r.assuntos.join('; ');
		this.settings.lastAssunto['__area'] = r.area;
		await this.saveSettings();
		this.updateStatus();
		new Notice(`Lembro: cartão criado em ${r.area}${r.assuntos.length ? ' > ' + r.assuntos[0] : ''} (^${id})`);
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
	constructor(private plugin: LembroPlugin) {
		super(plugin.app);
	}
	getSuggestions(q: string): string[] {
		return AREAS.filter((a) => a.toLowerCase().includes(q.toLowerCase()));
	}
	renderSuggestion(a: string, el: HTMLElement): void {
		el.setText(`${a} · ${this.plugin.session(a).length}`);
	}
	onChooseSuggestion(a: string): void {
		void this.plugin.review(a);
	}
}
