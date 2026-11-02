import { Component, ItemView, MarkdownRenderer, Notice, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { sectionOf } from '../cards/section';
import { clozes, hideCloze } from '../cards/cloze';
import { Card as FsrsCard } from 'ts-fsrs';
import { splitAlternatives } from '../capture/autoType';
import type LembroPlugin from '../main';
import { estimateMinutes, QueueItem, requeueIndex } from '../srs/queue';
import { checkCloze } from './answer';
import { fromStored, freshCard, isNew, Nota, NOTAS, toStored } from '../srs/scheduler';
import { CardState } from '../store/Store';

export const VIEW_TYPE_REVIEW = 'lembro-review';

interface Undo {
	index: number;
	id: string;
	before: CardState | undefined;
	/** where the card was put back in this session, if it was */
	requeued: number;
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
	/** grades undone with ← that → gives back, newest last */
	private redo: Nota[] = [];
	private label = 'Tudo';
	private ended = false;
	/** extra session: grades go to the log only, the schedule stays */
	private extra = false;
	/** typed cloze answer, or the letter marked on a question */
	private typed = '';
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
		this.scope?.register([], 'Enter', (e) => this.key(e, () => this.flip()));
		this.scope?.register([], 'e', (e) => this.key(e, () => this.edit()));
		this.scope?.register([], 's', (e) => this.key(e, () => void this.suspend()));
		this.scope?.register(['Mod'], 'z', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'ArrowLeft', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'ArrowRight', (e) => this.key(e, () => void this.redoNext()));
		this.scope?.register([], 'q', (e) => this.key(e, () => this.finish()));
		this.scope?.register([], 'Escape', (e) => this.key(e, () => void this.plugin.openPainel()));
		this.scope?.register([], 'p', (e) => this.key(e, () => this.skip()));
		this.scope?.register([], 'r', (e) => this.key(e, () => void this.restart()));
		this.draw();
	}

	async onClose(): Promise<void> {
		this.render.unload();
	}

	private key(e: KeyboardEvent, run: () => void): boolean {
		// typing in the answer field: only Enter reaches the session
		if ((e.target as HTMLElement | null)?.tagName === 'INPUT' && e.key !== 'Enter') return true;
		e.preventDefault();
		run();
		return false;
	}

	/** Starts a session with the given items. */
	start(queue: QueueItem[], label: string, extra = false): void {
		this.queue = queue;
		this.extra = extra;
		this.label = label;
		this.index = 0;
		this.ended = false;
		this.flipped = false;
		this.revealed = false;
		this.results = { 1: 0, 2: 0, 3: 0, 4: 0 };
		this.wrong = [];
		this.undo = [];
		this.redo = [];
		this.typed = '';
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
		const home = headLeft.createEl('button', { cls: 'lembro-back-btn lembro-home', attr: { 'aria-label': 'Voltar ao painel' } });
		setIcon(home, 'layout-dashboard');
		home.onclick = () => void this.plugin.openPainel();
		const prevBtn = headLeft.createEl('button', { text: 'Anterior', cls: 'lembro-back-btn', attr: { title: 'Volta ao cartão anterior e desfaz a avaliação dele (← ou Ctrl+Z)' } });
		prevBtn.disabled = !this.undo.length;
		prevBtn.onclick = () => void this.undoLast();
		const nextBtn = headLeft.createEl('button', { text: 'Próximo', cls: 'lembro-back-btn', attr: { title: 'Avança de novo com a mesma avaliação (→)' } });
		nextBtn.disabled = !this.redo.length;
		nextBtn.onclick = () => void this.redoNext();
		headLeft.createSpan({ text: this.extra ? `${this.label} · extra, não muda a agenda` : this.label });
		const left = estimateMinutes(this.queue.slice(this.index), this.plugin.secs());
		head.createSpan({ text: `${this.index + 1} de ${this.queue.length} · ~${Math.max(1, left)} min` });
		const bar = root.createDiv({ cls: 'lembro-bar' });
		bar.createEl('i').style.width = `${(this.index / this.queue.length) * 100}%`;

		const scene = root.createDiv({ cls: 'lembro-scene' });
		const card = scene.createDiv({ cls: 'lembro-card' + (this.flipped ? ' is-flipped' : '') });
		const sourcePath = item.card.file ?? '';
		const tag = `${item.area ?? 'Sem área'}${item.card.assuntos.length ? ' · ' + item.card.assuntos.join('; ') : ''} · ${item.card.tipo}${item.reverso ? ' · reverso' : ''}${sectionOf(item.card.fonte) ? ' · § ' + sectionOf(item.card.fonte) : ''}`;
		const hole = item.cloze !== undefined ? clozes(item.card.frente)[item.cloze] : undefined;
		const ask = hole !== undefined ? hideCloze(item.card.frente, item.cloze as number) : item.reverso ? item.card.verso : item.card.frente;
		const answer = hole ?? (item.reverso ? item.card.frente : item.card.verso);
		const extraBack = hole !== undefined ? item.card.verso : '';

		const front = card.createDiv({ cls: 'lembro-face lembro-front' });
		front.createDiv({ cls: 'lembro-tag', text: tag });
		const isQuestao = item.card.tipo === 'Questão' && !item.reverso;
		const frente = isQuestao ? splitAlternatives(ask) : ask;
		const q = front.createDiv({ cls: 'lembro-q' + (isQuestao ? ' is-questao' : '') });
		void MarkdownRenderer.render(this.app, frente, q, sourcePath, this.render);
		const typeCloze = item.card.tipo === 'Lacuna' && !item.reverso;
		if (typeCloze) {
			const input = front.createEl('input', { type: 'text', cls: 'lembro-type', attr: { placeholder: 'Digite a resposta' } });
			input.value = this.typed;
			input.onclick = (e) => e.stopPropagation();
			input.oninput = () => (this.typed = input.value);
			window.setTimeout(() => input.focus(), 50);
		}
		front.createDiv({ cls: 'lembro-hint', text: typeCloze ? 'Enter confere e vira' : 'Clique ou Espaço para virar' });

		const back = card.createDiv({ cls: 'lembro-face lembro-back' });
		back.createDiv({ cls: 'lembro-tag', text: tag });
		const bq = back.createDiv({ cls: 'lembro-backq' });
		void MarkdownRenderer.render(this.app, frente, bq, sourcePath, this.render);
		const check = typeCloze ? (this.typed.trim() ? checkCloze(this.typed, answer) : null) : null;
		if (check !== null) {
			back.createDiv({ cls: 'lembro-verdict ' + (check ? 'is-ok' : 'is-bad'), text: `${check ? '✓' : '✗'} Você respondeu: ${this.typed.trim()}` });
		}
		const a = back.createDiv({ cls: 'lembro-a' });
		void MarkdownRenderer.render(this.app, answer, a, sourcePath, this.render);
		if (extraBack) void MarkdownRenderer.render(this.app, extraBack, back.createDiv({ cls: 'lembro-muted' }), sourcePath, this.render);
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
		const tools = root.createDiv({ cls: 'lembro-tools' });
		const skipBtn = tools.createEl('button', { text: 'Pular', attr: { 'aria-label': 'Manda o cartão para o fim da sessão, sem avaliar' } });
		skipBtn.disabled = this.index >= this.queue.length - 1;
		skipBtn.onclick = () => this.skip();
		const resetBtn = tools.createEl('button', { text: 'Recomeçar', attr: { 'aria-label': 'Esquece a agenda do cartão: ele volta como novo' } });
		resetBtn.disabled = !item.fsrs;
		resetBtn.onclick = () => void this.restart();
		root.createDiv({ cls: 'lembro-keys', text: 'Espaço vira · 1 a 4 avaliam · P pula · R recomeça · E edita · S suspende · ← volta · → avança · Esc painel · Q encerra' });

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
		btns.createEl('button', { text: 'Voltar ao painel' }).onclick = () => void this.plugin.openPainel();
		btns.createEl('button', { text: 'Mais 5 minutos', cls: 'mod-cta' }).onclick = () => void this.plugin.review(null, 5);
	}

	/** Turns the card over; again turns it back. The grades stay once the back was seen. */
	private flip(): void {
		if (this.ended || !this.current()) return;
		this.flipped = !this.flipped;
		if (this.flipped) this.revealed = true;
		if (this.flipped && this.typed) {
			this.draw();
			return;
		}
		this.contentEl.querySelector('.lembro-card')?.toggleClass('is-flipped', this.flipped);
		if (this.revealed) this.contentEl.querySelector('.lembro-grades')?.addClass('is-on');
	}

	private async grade(nota: Nota, fromRedo = false): Promise<void> {
		const item = this.current();
		if (this.ended || !item || !this.revealed || !item.card.id) return;
		if (!fromRedo) this.redo = [];
		const id = item.key;
		const store = this.plugin.store;
		const before = store.state[id] ? { ...store.state[id] } : undefined;
		const now = new Date();
		const wasNew = isNew(item.fsrs);
		const next = this.plugin.scheduler.apply(this.fsrsOf(item), nota, now);
		if (!this.extra) store.state[id] = { st: 'ativo', fsrs: toStored(next) };
		try {
			await store.saveState();
			await store.appendLog({
				id,
				t: now.toISOString(),
				nota,
				segundos: Math.round((Date.now() - this.shownAt) / 1000),
				tipo: item.card.tipo,
				novo: wasNew,
				extra: this.extra,
			});
		} catch (e) {
			new Notice(`Lembro: não consegui gravar (${e instanceof Error ? e.message : String(e)})`);
			return;
		}
		if (!this.extra) item.fsrs = next;
		// only a missed card (Errei) comes back a few cards ahead; Difícil/Bom wait for the next session
		let requeued = -1;
		if (nota === 1) {
			requeued = this.extra ? Math.min(this.queue.length, this.index + 4) : requeueIndex(this.queue, this.index, next.due, now, this.plugin.secs());
			if (requeued >= 0) this.queue.splice(requeued, 0, { ...item });
		}
		this.undo.push({ index: this.index, id, before, requeued });
		this.typed = '';
		this.results[nota]++;
		if (nota === 1 && !this.wrong.some((w) => w.key === item.key)) this.wrong.push(item);
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
		if (u.requeued >= 0) this.queue.splice(u.requeued, 1);
		if (u.before) store.state[u.id] = u.before;
		else delete store.state[u.id];
		await store.saveState();
		const last = store.log[store.log.length - 1];
		if (last && last.id === u.id) {
			const nota = last.nota as Nota;
			this.redo.push(nota);
			this.results[nota]--;
			if (nota === 1) this.wrong = this.wrong.filter((w) => w.key !== u.id);
			await store.popLog();
		}
		const item = this.queue[u.index];
		if (item) item.fsrs = u.before?.fsrs ? fromStored(u.before.fsrs) : undefined;
		this.index = u.index;
		this.typed = '';
		this.ended = false;
		this.flipped = false;
		this.revealed = false;
		new Notice('De volta ao cartão anterior');
		this.plugin.updateStatus();
		this.draw();
	}

	/** → after ←: gives the card back the grade it had, and moves on. */
	private async redoNext(): Promise<void> {
		const nota = this.redo.pop();
		if (nota === undefined || this.ended || !this.current()) return;
		this.revealed = true;
		await this.grade(nota, true);
	}

	/** Puts the card at the end of the session without grading it. */
	private skip(): void {
		const item = this.current();
		if (this.ended || !item || this.index >= this.queue.length - 1) return;
		this.queue.splice(this.index, 1);
		this.queue.push(item);
		this.flipped = false;
		this.revealed = false;
		this.typed = '';
		new Notice('Cartão pulado: volta no fim');
		this.draw();
	}

	/** Forgets the schedule of the current card; it stays in the session as a new card. */
	private async restart(): Promise<void> {
		const item = this.current();
		if (this.ended || !item?.fsrs) return;
		await this.plugin.resetCard(item.card);
		for (const it of this.queue) if (it.card.id === item.card.id) delete it.fsrs;
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
		if (fresh) for (const it of this.queue) if (it.card.id === fresh.id) it.card = fresh;
		this.draw();
	}

	private async suspend(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const store = this.plugin.store;
		store.state[item.card.id] = { ...(store.state[item.card.id] ?? {}), st: 'suspenso' };
		await store.saveState();
		new Notice('Cartão suspenso');
		const cid = item.card.id;
		this.queue = this.queue.filter((it, i) => i < this.index || it.card.id !== cid);
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
