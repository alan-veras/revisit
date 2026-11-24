import { ItemView, MarkdownRenderer, Modifier, Notice, Platform, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { freshCard, isNew, toStored } from '../core/scheduler';
import { buildItems, buildQueue, faces, nextCardLabel, QueueItem } from '../core/queue';
import { GRADES, Grade, CardState } from '../core/types';
import type RevisitPlugin from '../main';

export const VIEW_TYPE_REVIEW = 'revisit-review';

// the wording is the design (lowercase, with the key letter), so it is joined here instead of written as one literal
const NEW_HINT = ['new', 'D discards'].join(' · ');
const ARMED_HINT = ['press', 'D again to discard'].join(' ');
const MORE_TEXT = ['5', 'more min'].join(' ');
const FLIP_TEXT = ['Space', 'or click to flip'].join(' ');

/** The keys the review answers to, shown by the ? button. */
const KEYS: [string, string][] = [
	['Space', 'Flip the card'],
	['1 2 3 4', 'Again, Hard, Good, Easy'],
	['E', 'Edit the card'],
	['O', 'Open the source note'],
	['D', 'Discard a new card'],
	[(Platform.isMacOS ? 'Cmd' : 'Ctrl') + ' Z', 'Undo the last grade'],
	['?', 'Show or hide this help'],
];

interface Undo {
	item: QueueItem;
	index: number;
	/** where the card was put back in the queue, -1 when it was not */
	inserted: number;
	before: CardState | undefined;
	fsrs: QueueItem['fsrs'];
}

/** One view, three moments: Start (pick the time), Review, Done. */
export class ReviewView extends ItemView {
	private mode: 'start' | 'review' | 'done' = 'start';
	private queue: QueueItem[] = [];
	private index = 0;
	private flipped = false;
	private shownAt = 0;
	private startedAt = 0;
	private endsAt = 0;
	private graded = new Map<string, number>();
	private undo: Undo[] = [];
	private preview: ReturnType<RevisitPlugin['scheduler']['preview']> | null = null;
	private discardArmed = false;
	/** a grade, undo or discard is being written: keys wait, so two never overlap */
	private busy = false;
	private bar: HTMLElement | null = null;
	private hint: HTMLElement | null = null;
	private disarm = 0;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: RevisitPlugin,
	) {
		super(leaf);
		const scope = (this.scope = new Scope(this.app.scope));
		const on = (key: string, fn: () => void, mods: Modifier[] = []) => scope.register(mods, key, () => (fn(), false));
		['1', '2', '3', '4'].forEach((k) => on(k, () => this.digit(Number(k))));
		on(' ', () => this.flip());
		on('e', () => this.editCard());
		on('o', () => this.openSource());
		on('d', () => void this.discard());
		on('z', () => void this.undoLast(), ['Mod']);
		on('?', () => this.toggleHelp(), ['Shift']);
	}

	get reviewing(): boolean {
		return this.mode === 'review';
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
		this.registerInterval(window.setInterval(() => this.tick(), 1000));
		await this.begin();
	}

	/** Back to the start: reads the cards again; nothing to review goes straight to Done. */
	async begin(): Promise<void> {
		await this.plugin.refresh();
		this.graded.clear();
		this.undo = [];
		this.queue = this.todayQueue();
		if (this.queue.length) this.show('start');
		else this.show('done');
	}

	private todayQueue(): QueueItem[] {
		const { store, scheduler } = this.plugin;
		return buildQueue(buildItems(store.cards, store.state), { now: new Date(), log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
	}

	private show(mode: 'start' | 'review' | 'done'): void {
		this.mode = mode;
		const root = this.contentEl;
		root.empty();
		root.addClass('revisit');
		this.bar = null;
		if (mode === 'start') this.drawStart(root);
		else if (mode === 'review') this.drawCard(root);
		else this.drawDone(root);
		if (mode !== 'done') this.drawHelp(root);
		this.plugin.updateStatus();
	}

	// ---- Start ----

	private drawStart(root: HTMLElement): void {
		const col = root.createDiv({ cls: 'revisit-col revisit-center' });
		col.createEl('h2', { text: 'How much time today?', cls: 'revisit-serif' });
		const row = col.createDiv({ cls: 'revisit-times' });
		[5, 10, 15].forEach((m, i) => {
			const b = row.createEl('button', { text: `${m} min`, cls: i === 1 ? 'mod-cta' : '' });
			b.createSpan({ text: String(i + 1), cls: 'revisit-key' });
			b.onclick = () => this.startSession(m);
		});
	}

	private startSession(minutes: number): void {
		this.index = 0;
		this.graded.clear();
		this.undo = [];
		this.startedAt = Date.now();
		this.endsAt = this.startedAt + minutes * 60_000;
		this.show('review');
	}

	// ---- Review ----

	private drawCard(root: HTMLElement): void {
		const item = this.queue[this.index];
		if (!item) return this.finish();
		this.flipped = false;
		this.discardArmed = false;
		window.clearTimeout(this.disarm);
		this.preview = this.plugin.scheduler.preview(item.fsrs ?? freshCard(new Date()), new Date());
		this.bar = root.createDiv({ cls: 'revisit-bar' }).createEl('i');
		this.tick();
		const hint = root.createDiv({ cls: 'revisit-hint', text: isNew(item.fsrs) ? NEW_HINT : '' });
		const col = root.createDiv({ cls: 'revisit-col' });
		const { front, back } = faces(item);
		const path = item.card.file ?? '';
		const q = col.createDiv({ cls: 'revisit-q revisit-serif' });
		const answer = col.createDiv({ cls: 'revisit-answer' });
		const a = answer.createDiv({ cls: 'revisit-a revisit-serif' });
		void MarkdownRenderer.render(this.app, front, q, path, this);
		void MarkdownRenderer.render(this.app, back, a, path, this);
		if (item.card.source) void MarkdownRenderer.render(this.app, item.card.source, answer.createDiv({ cls: 'revisit-src' }), path, this);
		col.onclick = (e) => {
			if (!(e.target as HTMLElement).closest('a, button')) this.flip();
		};
		col.querySelectorAll('a.internal-link').forEach((el) =>
			el.addEventListener('click', (ev) => {
				ev.preventDefault();
				void this.app.workspace.openLinkText(el.getAttribute('data-href') ?? '', path, 'split');
			}),
		);
		const grades = root.createDiv({ cls: 'revisit-grades' });
		for (const { grade, name } of GRADES) {
			const b = grades.createEl('button', { cls: `revisit-g${grade}` });
			const label = b.createSpan({ text: name, cls: 'revisit-grade-name' });
			label.createSpan({ text: String(grade), cls: 'revisit-key' });
			b.createSpan({ text: this.preview[grade].label, cls: 'revisit-grade-int' });
			b.onclick = () => void this.grade(grade);
		}
		grades.createDiv({ cls: 'revisit-flip', text: FLIP_TEXT });
		this.hint = hint;
		this.shownAt = Date.now();
	}

	// ---- Help ----

	/** A quiet ? in the corner; it opens the list of keys, so a first-time user is never stuck. */
	private drawHelp(root: HTMLElement): void {
		const btn = root.createEl('button', { cls: 'revisit-help-btn clickable-icon', attr: { 'aria-label': 'Keyboard shortcuts' } });
		setIcon(btn, 'help-circle');
		const panel = root.createDiv({ cls: 'revisit-help' });
		panel.createDiv({ cls: 'revisit-help-title', text: 'Keyboard shortcuts' });
		for (const [key, what] of KEYS) {
			const row = panel.createDiv({ cls: 'revisit-help-row' });
			row.createEl('kbd', { text: key });
			row.createSpan({ text: what });
		}
		btn.onclick = () => this.toggleHelp();
	}

	private toggleHelp(): void {
		this.contentEl.toggleClass('is-help', !this.contentEl.hasClass('is-help'));
	}

	private tick(): void {
		if (this.bar && this.mode === 'review') this.bar.style.width = `${Math.min(100, ((Date.now() - this.startedAt) / (this.endsAt - this.startedAt)) * 100)}%`;
	}

	private flip(): void {
		if (this.mode !== 'review' || this.flipped) return;
		this.flipped = true;
		this.contentEl.addClass('is-flipped');
	}

	private digit(n: number): void {
		if (this.mode === 'start' && n <= 3) this.startSession([5, 10, 15][n - 1] as number);
		else if (this.mode === 'review' && this.flipped && n <= 4) void this.grade(n as Grade);
	}

	private async grade(grade: Grade): Promise<void> {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || !this.preview || this.busy) return;
		this.busy = true;
		this.flipped = false;
		this.contentEl.removeClass('is-flipped');
		const { store } = this.plugin;
		const next = this.preview[grade].card;
		const entry = { id: item.key, t: new Date().toISOString(), grade, seconds: Math.round((Date.now() - this.shownAt) / 1000), type: item.card.type, new: isNew(item.fsrs), extra: false, state: item.fsrs?.state ?? 0 };
		const before = store.state[item.key];
		store.state[item.key] = { ...before, st: before?.st ?? 'active', fsrs: toStored(next) };
		const undo: Undo = { item, index: this.index, inserted: -1, before, fsrs: item.fsrs };
		item.fsrs = next;
		// a card still due today comes back a few cards later
		const end = new Date();
		end.setHours(23, 59, 59, 999);
		if (next.due <= end) {
			undo.inserted = Math.min(this.queue.length, this.index + 4);
			this.queue.splice(undo.inserted, 0, item);
		}
		this.undo.push(undo);
		this.graded.set(item.key, (this.graded.get(item.key) ?? 0) + 1);
		this.index++;
		try {
			await store.saveState();
			await store.appendLog(entry);
		} catch (e) {
			new Notice(`Revisit: could not save the grade (${e instanceof Error ? e.message : String(e)}).`);
		} finally {
			this.busy = false;
		}
		if (Date.now() >= this.endsAt) this.finish();
		else this.show('review');
	}

	private async undoLast(): Promise<void> {
		if (this.busy || this.mode === 'start') return;
		const u = this.undo.pop();
		if (!u) return;
		this.busy = true;
		const { store } = this.plugin;
		if (u.inserted >= 0 && this.queue[u.inserted] === u.item) this.queue.splice(u.inserted, 1);
		if (u.before) store.state[u.item.key] = u.before;
		else delete store.state[u.item.key];
		u.item.fsrs = u.fsrs;
		const n = (this.graded.get(u.item.key) ?? 1) - 1;
		if (n) this.graded.set(u.item.key, n);
		else this.graded.delete(u.item.key);
		try {
			await store.saveState();
			await store.popLog(u.item.key);
		} catch (e) {
			new Notice(`Revisit: could not undo (${e instanceof Error ? e.message : String(e)}).`);
		} finally {
			this.busy = false;
		}
		this.index = u.index;
		this.show('review');
	}

	private editCard(): void {
		const item = this.queue[this.index];
		if (this.mode === 'review' && item) this.plugin.openCreate({ card: item.card, onSaved: () => this.refreshCards() });
	}

	/** Cards edited from the session: the queue keeps its order, with the fresh text. */
	private refreshCards(): void {
		const byId = new Map(this.plugin.store.cards.map((c) => [c.id, c]));
		this.queue.forEach((it) => (it.card = byId.get(it.card.id) ?? it.card));
		this.show('review');
	}

	private openSource(): void {
		const item = this.queue[this.index];
		const target = /\[\[([^\]|]+)/.exec(item?.card.source ?? '')?.[1];
		if (this.mode === 'review' && target) void this.app.workspace.openLinkText(target, item?.card.file ?? '', 'split');
	}

	/** D on a new card: asks once more, then deletes it. */
	private async discard(): Promise<void> {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || !isNew(item.fsrs) || this.busy) return;
		window.clearTimeout(this.disarm);
		if (!this.discardArmed) {
			this.discardArmed = true;
			this.hint?.setText(ARMED_HINT);
			this.disarm = window.setTimeout(() => {
				this.discardArmed = false;
				this.hint?.setText(NEW_HINT);
			}, 3000);
			return;
		}
		this.busy = true;
		try {
			await this.plugin.store.deleteCard(item.card);
		} catch (e) {
			new Notice(`Revisit: could not delete the card (${e instanceof Error ? e.message : String(e)}).`);
			return;
		} finally {
			this.busy = false;
		}
		this.queue = this.queue.filter((it) => it.card.id !== item.card.id);
		this.show('review');
	}

	// ---- Done ----

	private finish(): void {
		this.show('done');
	}

	private drawDone(root: HTMLElement): void {
		const { store, scheduler } = this.plugin;
		const now = new Date();
		const items = buildItems(store.cards, store.state);
		const left = buildQueue(items, { now, log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
		const col = root.createDiv({ cls: 'revisit-col revisit-center' });
		const n = this.graded.size;
		col.createEl('h2', { text: n ? `Done. ${n} ${n === 1 ? 'card' : 'cards'}.` : 'All caught up.', cls: 'revisit-serif' });
		const next = left.length ? null : nextCardLabel(items, store.log, now);
		if (next) col.createDiv({ text: next, cls: 'revisit-muted' });
		if (left.length) {
			col.createEl('button', { text: MORE_TEXT }).onclick = () => {
				this.queue = left;
				this.startSession(5);
			};
		}
		col.createEl('a', { text: 'New card', cls: 'revisit-link' }).onclick = () => this.plugin.openCreate({ onSaved: () => (n ? this.show('done') : void this.begin()) });
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.disarm);
		this.contentEl.empty();
	}
}
