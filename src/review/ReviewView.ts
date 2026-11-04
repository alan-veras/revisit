import { topicsLabel } from '../cards/format';
import { Component, ItemView, MarkdownRenderer, Notice, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { sectionOf } from '../cards/section';
import { clozes, hideCloze } from '../cards/cloze';
import { Card as FsrsCard } from 'ts-fsrs';
import { splitAlternatives } from '../capture/autoType';
import type RevisitPlugin from '../main';
import { estimateMinutes, QueueItem, sessionRequeue } from '../srs/queue';
import { checkCloze, hintWords } from './answer';
import { IMPORTANT_TAG, isImportant } from '../cards/types';
import { fromStored, freshCard, isNew, Grade, GRADES, toStored } from '../srs/scheduler';
import { CardState } from '../store/Store';

export const VIEW_TYPE_REVIEW = 'revisit-review';

interface Undo {
	index: number;
	id: string;
	before: CardState | undefined;
	/** the copy put back in this session, if it was */
	requeuedItem?: QueueItem;
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
	private results: Record<Grade, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
	private wrong: QueueItem[] = [];
	private undo: Undo[] = [];
	/** grades undone with ← that → gives back, newest last */
	private redo: Grade[] = [];
	private label = 'Tudo';
	private ended = false;
	/** extra session: grades go to the log only, the schedule stays */
	private extra = false;
	/** resposta digitada na lacuna */
	private typed = '';
	/** words of the back shown as a hint on a Referência front */
	private hint = 0;
	private render = new Component();

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: RevisitPlugin,
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
		this.contentEl.addClass('revisit-review');
		this.scope = new Scope(this.app.scope);
		this.scope?.register([], ' ', (e) => this.key(e, () => this.flip()));
		for (const { grade } of GRADES) this.scope?.register([], String(grade), (e) => this.key(e, () => void this.grade(grade)));
		this.scope?.register([], 'Enter', (e) => this.key(e, () => this.flip()));
		this.scope?.register([], 'e', (e) => this.key(e, () => this.edit()));
		this.scope?.register([], 'i', (e) => this.key(e, () => void this.toggleImportant()));
		this.scope?.register([], 's', (e) => this.key(e, () => void this.suspend()));
		this.scope?.register(['Mod'], 'z', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'ArrowLeft', (e) => this.key(e, () => void this.undoLast()));
		this.scope?.register([], 'ArrowRight', (e) => this.key(e, () => void this.redoNext()));
		this.scope?.register([], 'q', (e) => this.key(e, () => this.finish()));
		this.scope?.register([], 'Escape', (e) => this.key(e, () => void this.plugin.openPainel()));
		this.scope?.register([], 'p', (e) => this.key(e, () => this.skip()));
		this.scope?.register([], 'r', (e) => this.key(e, () => void this.restart()));
		this.scope?.register([], 'd', (e) => this.key(e, () => this.moreHint()));
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
		this.hint = 0;
		this.startedAt = Date.now();
		this.draw();
	}

	private current(): QueueItem | undefined {
		return this.queue[this.index];
	}

	private fsrsOf(item: QueueItem): FsrsCard {
		return item.fsrs ?? freshCard(new Date());
	}

	private previewCache: { key: string; fsrs: FsrsCard | undefined; preview: Record<Grade, { card: FsrsCard; label: string }> } | null = null;

	/** Intervals shown on the grade buttons, frozen while the card is the same: the fuzz does not reshuffle on every redraw. */
	private previewOf(item: QueueItem): Record<Grade, { card: FsrsCard; label: string }> {
		if (this.previewCache && this.previewCache.key === item.key && this.previewCache.fsrs === item.fsrs) return this.previewCache.preview;
		const preview = this.plugin.scheduler.preview(this.fsrsOf(item), new Date(), isImportant(item.card));
		this.previewCache = { key: item.key, fsrs: item.fsrs, preview };
		return preview;
	}

	private draw(): void {
		this.render.unload();
		this.render = new Component();
		this.render.load();
		const root = this.contentEl;
		root.empty();
		if (this.ended) return this.drawEnd();
		if (!this.queue.length) {
			const box = root.createDiv({ cls: 'revisit-end' });
			box.createEl('h2', { text: 'Nada para revisar agora' });
			box.createEl('p', { text: 'Crie cartões pelo comando de captura, ou volte amanhã.', cls: 'revisit-muted' });
			return;
		}
		const item = this.current();
		if (!item) return this.drawEnd();

		const head = root.createDiv({ cls: 'revisit-head' });
		const headLeft = head.createSpan({ cls: 'revisit-head-left' });
		const home = headLeft.createEl('button', { cls: 'revisit-back-btn revisit-home', attr: { 'aria-label': 'Voltar ao painel' } });
		setIcon(home, 'layout-dashboard');
		home.onclick = () => void this.plugin.openPainel();
		const prevBtn = headLeft.createEl('button', { text: 'Anterior', cls: 'revisit-back-btn', attr: { title: 'Volta ao cartão anterior e desfaz a avaliação dele (← ou Ctrl+Z)' } });
		prevBtn.disabled = !this.undo.length;
		prevBtn.onclick = () => void this.undoLast();
		const nextBtn = headLeft.createEl('button', { text: 'Próximo', cls: 'revisit-back-btn', attr: { title: 'Avança de new com a mesma avaliação (→)' } });
		nextBtn.disabled = !this.redo.length;
		nextBtn.onclick = () => void this.redoNext();
		headLeft.createSpan({ text: this.extra ? `${this.label} · extra, não muda a agenda` : this.label });
		const left = estimateMinutes(this.queue.slice(this.index), this.plugin.secs());
		head.createSpan({ text: `${this.index + 1} de ${this.queue.length} · ~${Math.max(1, left)} min` });
		const bar = root.createDiv({ cls: 'revisit-bar' });
		bar.createEl('i').style.width = `${(this.index / this.queue.length) * 100}%`;

		const scene = root.createDiv({ cls: 'revisit-scene' });
		const card = scene.createDiv({ cls: 'revisit-card' + (this.flipped ? ' is-flipped' : '') });
		const sourcePath = item.card.file ?? '';
		const tag = `${item.area ?? 'Sem área'}${item.card.topics.length ? ' · ' + topicsLabel(item.card.topics) : ''} · ${item.card.type}${item.reverse ? ' · reverse' : ''}${sectionOf(item.card.source) ? ' · § ' + sectionOf(item.card.source) : ''}`;
		const hole = item.cloze !== undefined ? clozes(item.card.front)[item.cloze] : undefined;
		const ask = hole !== undefined ? hideCloze(item.card.front, item.cloze as number) : item.reverse ? item.card.back : item.card.front;
		const answer = hole ?? (item.reverse ? item.card.front : item.card.back);
		const extraBack = hole !== undefined ? item.card.back : '';

		const front = card.createDiv({ cls: 'revisit-face revisit-front' });
		const ftag = front.createDiv({ cls: 'revisit-tag', text: tag });
		if (this.plugin.settings.showNewBadge && isNew(item.fsrs)) ftag.prepend(createSpan({ cls: 'revisit-new-badge', text: 'Novo' }));
		const isQuestion = item.card.type === 'Questão' && !item.reverse;
		const questionText = isQuestion ? splitAlternatives(ask) : ask;
		const q = front.createDiv({ cls: 'revisit-q' + (isQuestion ? ' is-question' : '') });
		void MarkdownRenderer.render(this.app, questionText, q, sourcePath, this.render);
		const typeCloze = item.card.type === 'Lacuna' && !item.reverse;
		if (typeCloze) {
			const input = front.createEl('input', { type: 'text', cls: 'revisit-type', attr: { placeholder: 'Digite a resposta' } });
			input.value = this.typed;
			input.onclick = (e) => e.stopPropagation();
			input.oninput = () => (this.typed = input.value);
			window.setTimeout(() => input.focus(), 50);
		}
		if (this.canHint(item)) {
			const dica = front.createDiv({ cls: 'revisit-hint' });
			if (this.hint) dica.createDiv({ cls: 'revisit-hint-text', text: hintWords(item.card.back, this.hint) });
			const btn = dica.createEl('button', { text: 'Dica', attr: { 'aria-label': `Mostra mais ${this.plugin.settings.hintWords} palavras do texto` } });
			btn.onclick = (e) => {
				e.stopPropagation();
				this.moreHint();
			};
		}
		front.createDiv({ cls: 'revisit-flip-hint', text: typeCloze ? 'Enter confere e vira' : 'Clique ou Espaço para virar' });

		const back = card.createDiv({ cls: 'revisit-face revisit-back' });
		back.createDiv({ cls: 'revisit-tag', text: tag });
		const bq = back.createDiv({ cls: 'revisit-backq' });
		void MarkdownRenderer.render(this.app, questionText, bq, sourcePath, this.render);
		const check = typeCloze ? (this.typed.trim() ? checkCloze(this.typed, answer) : null) : null;
		if (check !== null) {
			back.createDiv({ cls: 'revisit-verdict ' + (check ? 'is-ok' : 'is-bad'), text: `${check ? '✓' : '✗'} Você respondeu: ${this.typed.trim()}` });
		}
		const a = back.createDiv({ cls: 'revisit-a' });
		void MarkdownRenderer.render(this.app, answer, a, sourcePath, this.render);
		if (extraBack) void MarkdownRenderer.render(this.app, extraBack, back.createDiv({ cls: 'revisit-muted' }), sourcePath, this.render);
		if (item.card.source) {
			const src = back.createDiv({ cls: 'revisit-src' });
			void MarkdownRenderer.render(this.app, `Fonte: ${item.card.source}`, src, sourcePath, this.render);
		}
		scene.onclick = (e) => {
			if ((e.target as HTMLElement).closest('a')) return;
			this.flip();
		};

		const grades = root.createDiv({ cls: 'revisit-grades' + (this.revealed ? ' is-on' : '') });
		const preview = this.previewOf(item);
		for (const { grade, name } of GRADES) {
			const b = grades.createEl('button', { cls: `revisit-g${grade}` });
			b.createEl('b', { text: name });
			b.createEl('small', { text: preview[grade].label });
			b.onclick = () => void this.grade(grade);
		}
		const tools = root.createDiv({ cls: 'revisit-tools' });
		const skipBtn = tools.createEl('button', { text: 'Pular', attr: { 'aria-label': 'Manda o cartão para o fim da sessão, sem avaliar' } });
		skipBtn.disabled = this.index >= this.queue.length - 1;
		skipBtn.onclick = () => this.skip();
		const resetBtn = tools.createEl('button', { text: 'Recomeçar', attr: { 'aria-label': 'Esquece a agenda do cartão: ele volta como new' } });
		resetBtn.disabled = !item.fsrs;
		resetBtn.onclick = () => void this.restart();
		root.createDiv({ cls: 'revisit-keys', text: 'Espaço vira · 1 a 4 avaliam · E edita · Q encerra' });

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
		const box = root.createDiv({ cls: 'revisit-end' });
		box.createEl('h2', { text: 'Sessão encerrada' });
		const done = this.results[1] + this.results[2] + this.results[3] + this.results[4];
		const ok = done - this.results[1];
		const min = Math.max(1, Math.round((Date.now() - this.startedAt) / 60000));
		box.createEl('p', { text: `${done} cartões · ${ok} lembrados · ${this.results[1]} para rever · ${min} min`, cls: 'revisit-muted' });
		box.createEl('p', { text: 'O que não coube aparece amanhã.', cls: 'revisit-muted' });
		if (this.wrong.length) {
			const list = box.createDiv({ cls: 'revisit-wrong' });
			list.createEl('h4', { text: 'Errados hoje' });
			for (const it of this.wrong) {
				const row = list.createDiv({ cls: 'revisit-wrong-row' });
				row.createSpan({ text: it.card.front.replace(/\s+/g, ' ').slice(0, 90) });
				row.createEl('button', { text: 'Editar' }).onclick = () => this.plugin.editCard(it.card);
			}
		}
		const btns = box.createDiv({ cls: 'revisit-buttons' });
		if (this.undo.length) btns.createEl('button', { text: 'Voltar ao último cartão' }).onclick = () => void this.undoLast();
		btns.createEl('button', { text: 'Voltar ao painel' }).onclick = () => void this.plugin.openPainel();
		btns.createEl('button', { text: 'Mais 5 minutos', cls: 'mod-cta' }).onclick = () => void this.plugin.review(null, 5);
	}

	/** A Referência asked from the reference: the first words of the text can be revealed. */
	private canHint(item: QueueItem): boolean {
		return item.card.type === 'Referência' && !item.reverse && item.cloze === undefined;
	}

	/** Shows three more words of the back on the front. */
	private moreHint(): void {
		const item = this.current();
		if (this.ended || !item || this.flipped || !this.canHint(item)) return;
		this.hint += this.plugin.settings.hintWords;
		this.draw();
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
		this.contentEl.querySelector('.revisit-card')?.toggleClass('is-flipped', this.flipped);
		if (this.revealed) this.contentEl.querySelector('.revisit-grades')?.addClass('is-on');
	}

	private async grade(grade: Grade, fromRedo = false): Promise<void> {
		const item = this.current();
		if (this.ended || !item || !this.revealed || !item.card.id) return;
		if (!fromRedo) this.redo = [];
		const id = item.key;
		const store = this.plugin.store;
		const before = store.state[id] ? { ...store.state[id] } : undefined;
		const now = new Date();
		const wasNew = isNew(item.fsrs);
		const prevCard = this.fsrsOf(item);
		const next = this.plugin.scheduler.apply(prevCard, grade, now, isImportant(item.card));
		if (!this.extra) store.state[id] = { st: 'active', fsrs: toStored(next) };
		try {
			await store.saveState();
			await store.appendLog({
				id,
				t: now.toISOString(),
				grade,
				seconds: Math.round((Date.now() - this.shownAt) / 1000),
				type: item.card.type,
				new: wasNew,
				extra: this.extra,
				state: prevCard.state,
			});
		} catch (e) {
			new Notice(`Lembro: não consegui gravar (${e instanceof Error ? e.message : String(e)})`);
			return;
		}
		if (!this.extra) item.fsrs = next;
		// a card whose next due falls inside the session comes back a few cards ahead
		const at = sessionRequeue({ extra: this.extra, grade, queue: this.queue, index: this.index, due: next.due, now, secs: this.plugin.secs(), gap: this.plugin.settings.requeueGap });
		let copy: QueueItem | undefined;
		if (at >= 0) {
			copy = { ...item };
			this.queue.splice(at, 0, copy);
		}
		this.undo.push({ index: this.index, id, before, requeuedItem: copy });
		this.typed = '';
		this.hint = 0;
		this.results[grade]++;
		if (grade === 1 && !this.wrong.some((w) => w.key === item.key)) this.wrong.push(item);
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
		if (u.requeuedItem) {
			const at = this.queue.indexOf(u.requeuedItem);
			if (at >= 0) this.queue.splice(at, 1);
		}
		if (u.before) store.state[u.id] = u.before;
		else delete store.state[u.id];
		await store.saveState();
		const last = store.log[store.log.length - 1];
		if (last && last.id === u.id) {
			const grade = last.grade as Grade;
			this.redo.push(grade);
			this.results[grade]--;
			if (grade === 1) this.wrong = this.wrong.filter((w) => w.key !== u.id);
			await store.popLog();
		}
		const item = this.queue[u.index];
		if (item) item.fsrs = u.before?.fsrs ? fromStored(u.before.fsrs) : undefined;
		this.index = u.index;
		this.typed = '';
		this.hint = 0;
		this.ended = false;
		this.flipped = false;
		this.revealed = false;
		new Notice('De volta ao cartão anterior');
		this.plugin.updateStatus();
		this.draw();
	}

	/** → after ←: gives the card back the grade it had, and moves on. */
	private async redoNext(): Promise<void> {
		const grade = this.redo.pop();
		if (grade === undefined || this.ended || !this.current()) return;
		this.revealed = true;
		await this.grade(grade, true);
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
		this.hint = 0;
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

	/** Marks or unmarks the current card as #importante (writes the Tags line). */
	private async toggleImportant(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const { start: _s, end: _e, file: _f, ...fields } = item.card;
		const tags = isImportant(item.card) ? (item.card.tags ?? []).filter((t) => t !== IMPORTANT_TAG) : [...(item.card.tags ?? []), IMPORTANT_TAG];
		await this.plugin.store.updateCard(item.card, { ...fields, tags });
		new Notice(tags.includes(IMPORTANT_TAG) ? 'Cartão marcado como importante' : 'Marca de importante removida');
		this.refreshCurrent();
	}

	private async suspend(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const store = this.plugin.store;
		store.state[item.card.id] = { ...(store.state[item.card.id] ?? {}), st: 'suspended' };
		await store.saveState();
		new Notice('Cartão suspended');
		const cid = item.card.id;
		this.queue = this.queue.filter((it, i) => i < this.index || it.card.id !== cid);
		this.flipped = false;
		this.hint = 0;
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
