import { topicsLabel } from '../cards/format';
import { Component, ItemView, MarkdownRenderer, Notice, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { sectionOf } from '../cards/section';
import { clozes, hideCloze } from '../cards/cloze';
import { Card as FsrsCard } from 'ts-fsrs';
import { splitAlternatives } from '../capture/autoType';
import type RevisitPlugin from '../main';
import { dueReviews, estimateMinutes, QueueItem, sessionRequeue, sourceName } from '../srs/queue';
import { dueCounts, forecastMinutes } from '../srs/forecast';
import { summarizeSession, toForecastCards } from '../srs/session';
import { checkCloze, hintWords } from './answer';
import { ConfirmModal } from '../ui/ConfirmModal';
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
	private label = 'All';
	private ended = false;
	/** extra session: grades go to the log only, the schedule stays */
	private extra = false;
	/** answer typed into the cloze */
	private typed = '';
	/** words of the back shown as a hint on a Reference front */
	private hint = 0;
	private render = new Component();
	/** minutes the person asked for on the start screen; null for everything due */
	private planned: number | null = null;

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
		return 'Revisit';
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
		this.scope?.register([], 'Escape', (e) => this.key(e, () => void this.plugin.openPanel()));
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
	start(queue: QueueItem[], label: string, extra = false, minutes?: number): void {
		this.queue = queue;
		this.planned = minutes !== undefined && Number.isFinite(minutes) ? minutes : null;
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
			box.createEl('h2', { text: 'Nothing to review now' });
			box.createEl('p', { text: 'Create cards with the capture command, or come back tomorrow.', cls: 'revisit-muted' });
			const btns = box.createDiv({ cls: 'revisit-buttons' });
			btns.createEl('button', { text: 'New card', cls: 'mod-cta' }).onclick = () => void this.plugin.captureFor(this.plugin.lastSource);
			btns.createEl('button', { text: 'Open panel' }).onclick = () => void this.plugin.openPanel();
			return;
		}
		const item = this.current();
		if (!item) return this.drawEnd();

		const head = root.createDiv({ cls: 'revisit-head' });
		const headLeft = head.createSpan({ cls: 'revisit-head-left' });
		const home = headLeft.createEl('button', { cls: 'revisit-back-btn revisit-home', attr: { 'aria-label': 'Back to the panel' } });
		setIcon(home, 'layout-dashboard');
		home.onclick = () => void this.plugin.openPanel();
		const prevBtn = headLeft.createEl('button', { text: 'Previous', cls: 'revisit-back-btn', attr: { title: 'Goes back to the previous card and undoes its grade (← or Ctrl+Z)', 'aria-label': 'Previous card, undoes its grade' } });
		prevBtn.disabled = !this.undo.length;
		prevBtn.onclick = () => void this.undoLast();
		const nextBtn = headLeft.createEl('button', { text: 'Next', cls: 'revisit-back-btn', attr: { title: 'Moves on again with the same grade (→)', 'aria-label': 'Next card, with the same grade' } });
		nextBtn.disabled = !this.redo.length;
		nextBtn.onclick = () => void this.redoNext();
		headLeft.createSpan({ text: this.extra ? `${this.label} · extra, does not change the schedule` : this.label });
		const left = estimateMinutes(this.queue.slice(this.index), this.plugin.secs());
		head.createSpan({ text: `${this.index + 1} of ${this.queue.length} · ~${Math.max(1, left)} min left` });
		const bar = root.createDiv({ cls: 'revisit-bar' });
		bar.createEl('i').style.width = `${(this.index / this.queue.length) * 100}%`;

		const scene = root.createDiv({ cls: 'revisit-scene' });
		const card = scene.createDiv({ cls: 'revisit-card' + (this.flipped ? ' is-flipped' : '') });
		const sourcePath = item.card.file ?? '';
		const tag = `${sourceName(item)}${item.card.topics.length ? ' · ' + topicsLabel(item.card.topics) : ''} · ${item.card.type}${item.reverse ? ' · reverse' : ''}${sectionOf(item.card.source) ? ' · § ' + sectionOf(item.card.source) : ''}`;
		const hole = item.cloze !== undefined ? clozes(item.card.front)[item.cloze] : undefined;
		const ask = hole !== undefined ? hideCloze(item.card.front, item.cloze as number) : item.reverse ? item.card.back : item.card.front;
		const answer = hole ?? (item.reverse ? item.card.front : item.card.back);
		const extraBack = hole !== undefined ? item.card.back : '';

		const front = card.createDiv({ cls: 'revisit-face revisit-front' });
		const ftag = front.createDiv({ cls: 'revisit-tag', text: tag });
		if (this.plugin.settings.showNewBadge && isNew(item.fsrs)) ftag.prepend(createSpan({ cls: 'revisit-new-badge', text: 'New' }));
		const isQuestion = item.card.type === 'Problem' && !item.reverse;
		const questionText = isQuestion ? splitAlternatives(ask) : ask;
		const q = front.createDiv({ cls: 'revisit-q' + (isQuestion ? ' is-question' : '') });
		void MarkdownRenderer.render(this.app, questionText, q, sourcePath, this.render);
		const typeCloze = item.card.type === 'Cloze' && !item.reverse;
		if (typeCloze) {
			const input = front.createEl('input', { type: 'text', cls: 'revisit-type', attr: { placeholder: 'Type the answer' } });
			input.value = this.typed;
			input.onclick = (e) => e.stopPropagation();
			input.oninput = () => (this.typed = input.value);
			window.setTimeout(() => input.focus(), 50);
		}
		if (this.canHint(item)) {
			const dica = front.createDiv({ cls: 'revisit-hint' });
			if (this.hint) dica.createDiv({ cls: 'revisit-hint-text', text: hintWords(item.card.back, this.hint) });
			const btn = dica.createEl('button', { text: 'Hint', attr: { 'aria-label': `Shows ${this.plugin.settings.hintWords} more words of the text` } });
			btn.onclick = (e) => {
				e.stopPropagation();
				this.moreHint();
			};
		}
		front.createDiv({ cls: 'revisit-flip-hint', text: typeCloze ? 'Enter checks and flips' : 'Tap the card or press Space to flip' });

		const back = card.createDiv({ cls: 'revisit-face revisit-back' });
		back.createDiv({ cls: 'revisit-tag', text: tag });
		const bq = back.createDiv({ cls: 'revisit-backq' });
		void MarkdownRenderer.render(this.app, questionText, bq, sourcePath, this.render);
		const check = typeCloze ? (this.typed.trim() ? checkCloze(this.typed, answer) : null) : null;
		if (check !== null) {
			back.createDiv({ cls: 'revisit-verdict ' + (check ? 'is-ok' : 'is-bad'), text: `${check ? '✓' : '✗'} You answered: ${this.typed.trim()}` });
		}
		const a = back.createDiv({ cls: 'revisit-a' });
		void MarkdownRenderer.render(this.app, answer, a, sourcePath, this.render);
		if (extraBack) void MarkdownRenderer.render(this.app, extraBack, back.createDiv({ cls: 'revisit-muted' }), sourcePath, this.render);
		if (item.card.source) {
			const src = back.createDiv({ cls: 'revisit-src' });
			void MarkdownRenderer.render(this.app, `Source: ${item.card.source}`, src, sourcePath, this.render);
		}
		scene.onclick = (e) => {
			if ((e.target as HTMLElement).closest('a')) return;
			this.flip();
		};

		const tools = root.createDiv({ cls: 'revisit-tools' });
		const skipBtn = tools.createEl('button', { text: 'Skip', attr: { 'aria-label': 'Sends the card to the end of the session, without grading' } });
		skipBtn.disabled = this.index >= this.queue.length - 1;
		skipBtn.onclick = () => this.skip();
		const resetBtn = tools.createEl('button', { text: 'Reset', attr: { 'aria-label': "Forgets the card's schedule: it comes back as new" } });
		resetBtn.disabled = !item.fsrs;
		resetBtn.onclick = () => void this.restart();
		const delBtn = tools.createEl('button', { text: 'Delete', attr: { 'aria-label': 'Deletes the card after a confirmation' } });
		delBtn.onclick = () => this.askDelete();
		root.createDiv({ cls: 'revisit-keys', text: 'Space flips · 1 to 4 grade · D hint · E edits · Q ends' });
		this.dock = root.createDiv({ cls: 'revisit-dock' });
		this.drawDock();

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

	private dock: HTMLElement | null = null;

	/** The bar fixed at the bottom: Show answer first, the four grades once the back was seen. */
	private drawDock(): void {
		const item = this.current();
		if (!this.dock || !item) return;
		this.dock.empty();
		if (!this.revealed) {
			const show = this.dock.createEl('button', { text: 'Show answer', cls: 'mod-cta revisit-show' });
			show.onclick = () => this.flip();
			return;
		}
		const grades = this.dock.createDiv({ cls: 'revisit-grades', attr: { role: 'group', 'aria-label': 'Grade the answer' } });
		const preview = this.previewOf(item);
		for (const { grade, name } of GRADES) {
			const b = grades.createEl('button', { cls: `revisit-g${grade}`, attr: { 'aria-label': `${name}, back in ${preview[grade].label}` } });
			b.createEl('b', { text: name });
			b.createEl('small', { text: preview[grade].label });
			b.onclick = () => void this.grade(grade);
		}
	}

	private drawEnd(): void {
		const root = this.contentEl;
		const box = root.createDiv({ cls: 'revisit-end' });
		const sum = summarizeSession(this.results, this.startedAt, Date.now());
		box.createEl('h2', { text: 'Session finished' });
		box.createEl('p', {
			text: sum.cards ? `${sum.minutes} min: ${sum.cards} ${sum.cards === 1 ? 'card' : 'cards'}, ${sum.percentRight}% right` : 'No cards answered',
			cls: 'revisit-muted',
		});
		const stats = box.createDiv({ cls: 'revisit-stats' });
		const stat = (v: string, label: string) => {
			const d = stats.createDiv();
			d.createDiv({ cls: 'revisit-stat-v', text: v });
			d.createDiv({ cls: 'revisit-muted', text: label });
		};
		stat(String(sum.cards), sum.cards === 1 ? 'card' : 'cards');
		stat(sum.percentRight === null ? '-' : `${sum.percentRight}%`, 'right');

		// tomorrow, from the schedule as it stands after this session
		const now = new Date();
		const items = this.plugin.items();
		const cards = toForecastCards(items);
		const f = forecastMinutes(cards, this.plugin.secs(), now, 8);
		const tomorrowCards = dueCounts(cards, now, 8)[1] ?? 0;
		const later = dueReviews(items, now).length;
		const rows = box.createDiv({ cls: 'revisit-sum' });
		const row = (icon: string, title: string, sub: string, value: string) => {
			const r = rows.createDiv({ cls: 'revisit-sum-row' });
			setIcon(r.createSpan({ cls: 'revisit-sum-icon' }), icon);
			const t = r.createSpan({ cls: 'revisit-sum-text' });
			t.createEl('b', { text: title });
			t.createSpan({ cls: 'revisit-muted', text: sub });
			r.createSpan({ cls: 'revisit-sum-value', text: value });
		};
		row('clock', 'Tomorrow', `${tomorrowCards} ${tomorrowCards === 1 ? 'card is' : 'cards are'} due`, `~${Math.max(tomorrowCards ? 1 : 0, Math.round(f.tomorrow))} min`);
		row('bar-chart-2', 'Next 7 days', 'average per day', `~${Math.round(f.perDay.slice(1, 8).reduce((a, b) => a + b, 0) / 7)} min`);
		if (later) row('plus', 'Backlog', `${later} ${later === 1 ? 'card' : 'cards'} left for later`, String(later));

		if (this.wrong.length) {
			const list = box.createDiv({ cls: 'revisit-wrong' });
			list.createEl('h4', { text: 'Missed today' });
			for (const it of this.wrong) {
				const r = list.createDiv({ cls: 'revisit-wrong-row' });
				r.createSpan({ text: it.card.front.replace(/\s+/g, ' ').slice(0, 90) });
				r.createEl('button', { text: 'Edit' }).onclick = () => this.plugin.editCard(it.card);
			}
		}
		const btns = box.createDiv({ cls: 'revisit-buttons' });
		btns.createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => void this.plugin.openPanel();
		if (later && !this.extra) btns.createEl('button', { text: `Continue for ${this.planned && this.planned < 10 ? 5 : 10} more min` }).onclick = () => void this.plugin.review(null, this.planned && this.planned < 10 ? 5 : 10);
		if (this.undo.length) btns.createEl('button', { text: 'Back to the last card' }).onclick = () => void this.undoLast();
	}

	/** A Reference asked from the reference: the first words of the text can be revealed. */
	private canHint(item: QueueItem): boolean {
		return item.card.type === 'Reference' && !item.reverse && item.cloze === undefined;
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
		this.drawDock();
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
			new Notice(`Revisit: could not save (${e instanceof Error ? e.message : String(e)})`);
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
		new Notice('Back to the previous card');
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
		new Notice('Card skipped: comes back at the end');
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

	/** Confirm window for deleting the current card; the session moves on right after. */
	private askDelete(): void {
		const item = this.current();
		if (this.ended || !item?.card.id) return;
		if (item.card.inline) return void new Notice('Revisit: this card is written in the note; delete it there.');
		new ConfirmModal(this.app, 'Delete card', item.card.front.replace(/\s+/g, ' ').slice(0, 140), 'Delete', () => void this.removeCurrent());
	}

	/** Deletes the current card (and its reverse, clozes and schedule) and shows the next one. */
	private async removeCurrent(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const cid = item.card.id;
		await this.plugin.deleteCard(item.card);
		this.queue = this.queue.filter((it, i) => i < this.index || it.card.id !== cid);
		// a deleted card cannot come back: its past grades and its "missed" line go with it
		this.undo = this.undo.filter((u) => !(u.id === cid || u.id.startsWith(cid + '-')));
		this.wrong = this.wrong.filter((w) => w.card.id !== cid);
		this.flipped = false;
		this.revealed = false;
		this.typed = '';
		this.hint = 0;
		if (!this.queue.length) this.ended = true;
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

	/** Marks or unmarks the current card as #important (writes the Tags line). */
	private async toggleImportant(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		if (item.card.inline) return void new Notice('Revisit: this card is written in the note; change it there.');
		const { start: _s, end: _e, file: _f, ...fields } = item.card;
		const tags = isImportant(item.card) ? (item.card.tags ?? []).filter((t) => t !== IMPORTANT_TAG) : [...(item.card.tags ?? []), IMPORTANT_TAG];
		await this.plugin.store.updateCard(item.card, { ...fields, tags });
		new Notice(tags.includes(IMPORTANT_TAG) ? 'Card marked as important' : 'Important mark removed');
		this.refreshCurrent();
	}

	private async suspend(): Promise<void> {
		const item = this.current();
		if (!item?.card.id) return;
		const store = this.plugin.store;
		store.state[item.card.id] = { ...(store.state[item.card.id] ?? {}), st: 'suspended' };
		await store.saveState();
		new Notice('Card suspended');
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
