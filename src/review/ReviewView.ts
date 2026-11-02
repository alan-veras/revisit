import { Component, ItemView, MarkdownRenderer, Notice, Scope, WorkspaceLeaf } from 'obsidian';
import { Card as FsrsCard } from 'ts-fsrs';
import { splitAlternatives } from '../capture/autoType';
import type LembroPlugin from '../main';
import { estimateMinutes, QueueItem } from '../srs/queue';
import { fromStored, freshCard, isNew, Nota, NOTAS, toStored } from '../srs/scheduler';
import { CardState } from '../store/Store';

export const VIEW_TYPE_REVIEW = 'lembro-review';

interface Undo {
	index: number;
	id: string;
	before: CardState | undefined;
}

/** The session: one card at a time, the front first, then it turns over. */
export class ReviewView extends ItemView {
	private queue: QueueItem[] = [];
	private index = 0;
	private flipped = false;
	/** the back of the current card was shown at least once */
	private revealed = false;
	private shownAt = 0;
	private startedAt = 0;
	private results: Record<Nota, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
	private wrong: QueueItem[] = [];
	private undo: Undo[] = [];
	private label = 'Tudo';
	private ended = false;
	private render = new Component();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LembroPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_REVIEW;
	}
	getDisplayText(): string {
		return 'Lembro';
	}
	getIcon(): string {
		return 'layers';
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('lembro-review');
		this.scope = new Scope(this.app.scope);
		this.scope?.register([], ' ', (e) => this.key(e, () => this.flip()));
		for (const { nota } of NOTAS) this.scope?.register([], String(nota), (e) => this.key(e, () => void this.grade(nota)));
		this.scope?.register([], 'e', (e) => this.key(e, () => this.edit()));
		this.scope?.register([], 's', (e) => this.key(e, () => void this.suspend()));
		this.scope?.register(['Mod'], 'z', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'ArrowLeft', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'q', (e) => this.key(e, () => this.finish()));
		this.draw();
	}

	async onClose(): Promise<void> {
		this.render.unload();
	}

	private key(e: KeyboardEvent, run: () => void): boolean {
		e.preventDefault();
		run();
		return false;
	}

	/** Starts a session with the given items. */
	start(queue: QueueItem[], label: string): void {
		this.queue = queue;
		this.label = label;
		this.index = 0;
		this.ended = false;
		this.flipped = false;
		this.revealed = false;
		this.results = { 1: 0, 2: 0, 3: 0, 4: 0 };
		this.wrong = [];
		this.undo = [];
		this.startedAt = Date.now();
		this.draw();
	}

	private current(): QueueItem | undefined {
		return this.queue[this.index];
	}

	private fsrsOf(item: QueueItem): FsrsCard {
		return item.fsrs ?? freshCard(new Date());
	}

	private draw(): void {
		this.render.unload();
		this.render = new Component();
		this.render.load();
		const root = this.contentEl;
		root.empty();
		if (this.ended) return this.drawEnd();
		if (!this.queue.length) {
			const box = root.createDiv({ cls: 'lembro-end' });
			box.createEl('h2', { text: 'Nada para revisar agora' });
			box.createEl('p', { text: 'Crie cartões pelo comando de captura, ou volte amanhã.', cls: 'lembro-muted' });
			return;
		}
		const item = this.current();
		if (!item) return this.drawEnd();

		const head = root.createDiv({ cls: 'lembro-head' });
		const headLeft = head.createSpan({ cls: 'lembro-head-left' });
		const prevBtn = headLeft.createEl('button', { text: 'Anterior', cls: 'lembro-back-btn', attr: { title: 'Volta ao cartão anterior e desfaz a avaliação dele (← ou Ctrl+Z)' } });
		prevBtn.disabled = !this.undo.length;
		prevBtn.onclick = () => void this.undoLast();
		headLeft.createSpan({ text: this.label });
		const left = estimateMinutes(this.queue.slice(this.index), this.plugin.secs());
		head.createSpan({ text: `${this.index + 1} de ${this.queue.length} · ~${Math.max(1, left)} min` });
		const bar = root.createDiv({ cls: 'lembro-bar' });
		bar.createEl('i').style.width = `${(this.index / this.queue.length) * 100}%`;

		const scene = root.createDiv({ cls: 'lembro-scene' });
		const card = scene.createDiv({ cls: 'lembro-card' + (this.flipped ? ' is-flipped' : '') });
		const sourcePath = item.card.file ?? '';
		const tag = `${item.area ?? 'Sem área'}${item.card.assuntos.length ? ' · ' + item.card.assuntos.join('; ') : ''} · ${item.card.tipo}`;

		const front = card.createDiv({ cls: 'lembro-face lembro-front' });
		front.createDiv({ cls: 'lembro-tag', text: tag });
		const isQuestao = item.card.tipo === 'Questão';
		const frente = isQuestao ? splitAlternatives(item.card.frente) : item.card.frente;
		const q = front.createDiv({ cls: 'lembro-q' + (isQuestao ? ' is-questao' : '') });
		void MarkdownRenderer.render(this.app, frente, q, sourcePath, this.render);
		front.createDiv({ cls: 'lembro-hint', text: 'Clique ou Espaço para virar' });

		const back = card.createDiv({ cls: 'lembro-face lembro-back' });
		back.createDiv({ cls: 'lembro-tag', text: tag });
		const bq = back.createDiv({ cls: 'lembro-backq' });
		void MarkdownRenderer.render(this.app, frente, bq, sourcePath, this.render);
		const a = back.createDiv({ cls: 'lembro-a' });
		void MarkdownRenderer.render(this.app, item.card.verso, a, sourcePath, this.render);
		if (item.card.fonte) {
			const src = back.createDiv({ cls: 'lembro-src' });
			void MarkdownRenderer.render(this.app, `Fonte: ${item.card.fonte}`, src, sourcePath, this.render);
		}
		scene.onclick = (e) => {
			if ((e.target as HTMLElement).closest('a')) return;
			this.flip();
		};

		const grades = root.createDiv({ cls: 'lembro-grades' + (this.revealed ? ' is-on' : '') });
		const preview = this.plugin.scheduler.preview(this.fsrsOf(item), new Date());
		for (const { nota, nome } of NOTAS) {
			const b = grades.createEl('button', { cls: `lembro-g${nota}` });
			b.createEl('b', { text: nome });
			b.createEl('small', { text: preview[nota].label });
			b.onclick = () => void this.grade(nota);
		}
		root.createDiv({ cls: 'lembro-keys', text: 'Espaço vira e desvira · 1 a 4 avaliam · E edita · S suspende · ← volta ao anterior · Q encerra' });

		// links in the rendered card open the source next to the session
		root.querySelectorAll('a.internal-link').forEach((el) =>
			el.addEventListener('click', (ev) => {
				ev.preventDefault();
				const href = el.getAttribute('data-href') ?? '';
				void this.app.workspace.openLinkText(href, sourcePath, 'split');
			}),
		);
		this.shownAt = Date.now();
	}

	private drawEnd(): void {
		const root = this.contentEl;
		const box = root.createDiv({ cls: 'lembro-end' });
		box.createEl('h2', { text: 'Sessão encerrada' });
		const done = this.results[1] + this.results[2] + this.results[3] + this.results[4];
		const ok = done - this.results[1];
		const min = Math.max(1, Math.round((Date.now() - this.startedAt) / 60000));
		box.createEl('p', { text: `${done} cartões · ${ok} lembrados · ${this.results[1]} para rever · ${min} min`, cls: 'lembro-muted' });
		box.createEl('p', { text: 'O que não coube aparece amanhã.', cls: 'lembro-muted' });
		if (this.wrong.length) {
			const list = box.createDiv({ cls: 'lembro-wrong' });
			list.createEl('h4', { text: 'Errados hoje' });
			for (const it of this.wrong) {
				const row = list.createDiv({ cls: 'lembro-wrong-row' });
				row.createSpan({ text: it.card.frente.replace(/\s+/g, ' ').slice(0, 90) });
				row.createEl('button', { text: 'Editar' }).onclick = () => this.plugin.editCard(it.card);
			}
		}
		const btns = box.createDiv({ cls: 'lembro-buttons' });
		if (this.undo.length) btns.createEl('button', { text: 'Voltar ao último cartão' }).onclick = () => void this.undoLast();
		btns.createEl('button', { text: 'Mais 5 minutos', cls: 'mod-cta' }).onclick = () => void this.plugin.review(null, 5);
	}

	/** Turns the card over; again turns it back. The grades stay once the back was seen. */
	private flip(): void {
		if (this.ended || !this.current()) return;
		this.flipped = !this.flipped;
		if (this.flipped) this.revealed = true;
		this.contentEl.querySelector('.lembro-card')?.toggleClass('is-flipped', this.flipped);
		if (this.revealed) this.contentEl.querySelector('.lembro-grades')?.addClass('is-on');
	}

	private async grade(nota: Nota): Promise<void> {
		const item = this.current();
		if (this.ended || !item || !this.revealed || !item.card.id) return;
		const id = item.card.id;
		const store = this.plugin.store;
		const before = store.state[id] ? { ...store.state[id] } : undefined;
		const now = new Date();
		const wasNew = isNew(item.fsrs);
		const next = this.plugin.scheduler.apply(this.fsrsOf(item), nota, now);
		store.state[id] = { st: 'ativo', fsrs: toStored(next) };
		try {
			await store.saveState();
			await store.appendLog({
				id,
				t: now.toISOString(),
				nota,
				segundos: Math.round((Date.now() - this.shownAt) / 1000),
				tipo: item.card.tipo,
				novo: wasNew,
				extra: false,
			});
		} catch (e) {
			new Notice(`Lembro: não consegui gravar (${e instanceof Error ? e.message : String(e)})`);
			return;
		}
		item.fsrs = next;
		this.undo.push({ index: this.index, id, before });
		this.results[nota]++;
		if (nota === 1) this.wrong.push(item);
		this.index++;
		this.flipped = false;
		this.revealed = false;
		this.plugin.updateStatus();
		this.draw();
	}

	private async undoLast(): Promise<void> {
		const u = this.undo.pop();
		if (!u) return;
		const store = this.plugin.store;
		if (u.before) store.state[u.id] = u.before;
		else delete store.state[u.id];
		await store.saveState();
		const last = store.log[store.log.length - 1];
		if (last && last.id === u.id) {
			const nota = last.nota as Nota;
			this.results[nota]--;
			if (nota === 1) this.wrong = this.wrong.filter((w) => w.card.id !== u.id);
			await store.popLog();
		}
		const item = this.queue[u.index];
		if (item) item.fsrs = u.before?.fsrs ? fromStored(u.before.fsrs) : undefined;
		this.index = u.index;
		this.ended = false;
		this.flipped = false;
		this.revealed = false;
		new Notice('De volta ao cartão anterior');
		this.plugin.updateStatus();
		this.draw();
	}

	private edit(): void {
		const item = this.current();
		if (item) this.plugin.editCard(item.card, () => this.refreshCurrent());
	}

	private refreshCurrent(): void {
		const item = this.current();
		if (!item) return;
		const fresh = this.plugin.store.cards.find((c) => c.id === item.card.id);
		if (fresh) item.card = fresh;
		this.draw();
	}

	private async suspend(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const store = this.plugin.store;
		store.state[item.card.id] = { ...(store.state[item.card.id] ?? {}), st: 'suspenso' };
		await store.saveState();
		new Notice('Cartão suspenso');
		this.queue.splice(this.index, 1);
		this.flipped = false;
		this.revealed = false;
		this.plugin.updateStatus();
		this.draw();
	}

	private finish(): void {
		if (!this.queue.length) return;
		this.ended = true;
		this.draw();
	}
}
