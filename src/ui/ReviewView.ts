import { ItemView, MarkdownRenderer, Menu, Modal, Modifier, normalizePath, Notice, Platform, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { groupDecks } from '../core/decks';
import { formatInterval, freshCard, isNew, State, toStored } from '../core/scheduler';
import { buildItems, buildQueue, extraQueue, faces, nextCardLabel, QueueItem } from '../core/queue';
import { GRADES, Grade, CardState } from '../core/types';
import type RevisitPlugin from '../main';

export const VIEW_TYPE_REVIEW = 'revisit-review';

type Mode = 'start' | 'review' | 'done' | 'decks';

// the wording is the design (lowercase, with the key letter), so it is joined here instead of written as one literal
const NEW_HINT = ['new', 'D discards'].join(' · ');
const ARMED_HINT = ['press', 'D again to delete this card'].join(' ');
const TIMES = [2, 5, 10];
const FLIP_TEXT = Platform.isMobile ? 'Tap to flip' : ['Space', 'or click to flip'].join(' ');

/** The keys the review answers to, shown by the ? button. */
const KEYS: [string, string][] = [
	['Space', 'Flip the card'],
	['1 2 3 4', 'Again, Hard, Good, Easy'],
	['E', 'Edit the card'],
	['O', 'Open the source note'],
	['D D', 'Delete the card'],
	[(Platform.isMacOS ? 'Cmd' : 'Ctrl') + ' Z', 'Undo the last grade'],
	['?', 'Show or hide this help'],
];

interface Undo {
	item: QueueItem;
	index: number;
	/** where the card was put back in the queue, -1 when it was not */
	before: CardState | undefined;
	fsrs: QueueItem['fsrs'];
}

/** One view, three moments: Start (pick the time), Review, Done. */
export class ReviewView extends ItemView {
	private mode: Mode = 'start';
	/** the deck opened on the Decks screen */
	private openDeck = '';
	/** begin() is reading the cards; Decks asked meanwhile waits for it */
	private starting = false;
	private decksNext = false;
	private queue: QueueItem[] = [];
	private index = 0;
	private flipped = false;
	private shownAt = 0;
	private startedAt = 0;
	private endsAt = 0;
	private graded = new Map<string, number>();
	/** graded cards that come back later today: they rejoin the queue only once their time has come */
	private waiting: QueueItem[] = [];
	private undo: Undo[] = [];
	private preview: ReturnType<RevisitPlugin['scheduler']['preview']> | null = null;
	private discardArmed = false;
	/** a grade, undo or discard is being written: keys wait, so two never overlap */
	private busy = false;
	private bar: HTMLElement | null = null;
	private hint: HTMLElement | null = null;
	private disarm = 0;
	/** the length picked at Start; Keep going offers it again */
	private minutes = TIMES[0] as number;
	/** what Keep going would review, worked out when Done is drawn */
	private more: QueueItem[] = [];

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
		this.starting = true;
		try {
			await this.plugin.refresh();
		} finally {
			this.starting = false;
		}
		this.graded.clear();
		this.undo = [];
		this.waiting = [];
		this.queue = this.todayQueue();
		if (this.decksNext) {
			this.decksNext = false;
			this.show('decks');
		} else if (this.queue.length) this.show('start');
		else this.show('done');
	}

	private todayQueue(): QueueItem[] {
		const { store, scheduler } = this.plugin;
		return buildQueue(buildItems(store.cards, store.state), { now: new Date(), log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
	}

	private show(mode: Mode): void {
		this.mode = mode;
		const root = this.contentEl;
		root.empty();
		root.addClass('revisit');
		root.toggleClass('is-touch', Platform.isMobile);
		this.bar = null;
		if (mode === 'start') this.drawStart(root);
		else if (mode === 'review') this.drawCard(root);
		else if (mode === 'decks') this.drawDecks(root);
		else this.drawDone(root);
		if (mode === 'review' && Platform.isMobile) this.drawMenu(root);
		else if ((mode === 'start' || mode === 'review') && !Platform.isMobile) this.drawHelp(root);
		this.plugin.updateStatus();
	}

	// ---- Start ----

	private drawStart(root: HTMLElement): void {
		const col = root.createDiv({ cls: 'revisit-col revisit-center' });
		col.createEl('h2', { text: 'How much time today?', cls: 'revisit-serif' });
		this.drawTimes(col, (m) => this.startSession(m));
		this.decksLink(col);
	}

	/** The three lengths, with their keys; the one picked last is highlighted. */
	private drawTimes(col: HTMLElement, pick: (minutes: number) => void): void {
		const row = col.createDiv({ cls: 'revisit-times' });
		TIMES.forEach((m, i) => {
			const b = row.createEl('button', { text: `${m} min`, cls: m === this.minutes ? 'mod-cta' : '' });
			if (!Platform.isMobile) b.createSpan({ text: String(i + 1), cls: 'revisit-key' });
			b.onclick = () => pick(m);
		});
	}

	private keepGoing(minutes: number): void {
		if (!this.more.length) return;
		this.queue = this.more;
		this.startSession(minutes, true);
	}

	/** `more` keeps going after Done: the count and the undo history carry on. */
	private startSession(minutes: number, more = false): void {
		this.minutes = minutes;
		this.index = 0;
		if (!more) {
			this.graded.clear();
			this.undo = [];
			this.waiting = [];
		}
		this.startedAt = Date.now();
		this.endsAt = this.startedAt + minutes * 60_000;
		this.show('review');
	}

	// ---- Review ----

	private drawCard(root: HTMLElement): void {
		const now = Date.now();
		const ready = this.waiting.filter((it) => (it.fsrs?.due.getTime() ?? 0) <= now);
		if (ready.length) {
			this.waiting = this.waiting.filter((it) => !ready.includes(it));
			this.queue.splice(this.index, 0, ...ready);
		}
		const item = this.queue[this.index];
		if (!item) return this.finish();
		this.flipped = false;
		this.contentEl.removeClass('is-flipped');
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
			if (!Platform.isMobile) label.createSpan({ text: String(grade), cls: 'revisit-key' });
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

	/** On touch screens the ? becomes a ⋯ menu with the actions that have keys on the desktop. */
	private drawMenu(root: HTMLElement): void {
		const btn = root.createEl('button', { cls: 'revisit-help-btn clickable-icon', attr: { 'aria-label': 'Card actions' } });
		setIcon(btn, 'more-horizontal');
		btn.onclick = (ev) => {
			const menu = new Menu();
			menu.addItem((i) => i.setTitle('Edit card').setIcon('pencil').onClick(() => this.editCard()));
			menu.addItem((i) => i.setTitle('Open source note').setIcon('file-text').onClick(() => this.openSource()));
			menu.addItem((i) => i.setTitle('Delete card').setIcon('trash').onClick(() => void this.confirmDelete()));
			menu.addItem((i) => i.setTitle('Undo last grade').setIcon('undo-2').onClick(() => void this.undoLast()));
			menu.showAtMouseEvent(ev);
		};
	}

	/** Delete from the menu: one short confirmation instead of the double D. */
	private async confirmDelete(): Promise<void> {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || this.busy) return;
		const ok = await new Promise<boolean>((resolve) => {
			const m = new Modal(this.app);
			m.titleEl.setText('Delete this card?');
			const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
			row.createEl('button', { text: 'Delete', cls: 'mod-warning' }).onclick = () => (resolve(true), m.close());
			row.createEl('button', { text: 'Cancel' }).onclick = () => m.close();
			m.onClose = () => resolve(false);
			m.open();
		});
		if (!ok) return;
		this.discardArmed = true;
		await this.discard();
	}

	private toggleHelp(): void {
		this.contentEl.toggleClass('is-help', !this.contentEl.hasClass('is-help'));
	}

	private tick(): void {
		if (this.bar && this.mode === 'review') this.bar.style.width = `${Math.min(100, ((Date.now() - this.startedAt) / (this.endsAt - this.startedAt)) * 100)}%`;
	}

	private flip(): void {
		if (this.mode !== 'review' || this.busy) return;
		this.flipped = !this.flipped;
		this.contentEl.toggleClass('is-flipped', this.flipped);
	}

	private digit(n: number): void {
		if (this.mode === 'start' && n <= 3) this.startSession(TIMES[n - 1] as number);
		else if (this.mode === 'done' && n <= 3) this.keepGoing(TIMES[n - 1] as number);
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
		store.setEntry(item.key, { ...before, st: before?.st ?? 'active', fsrs: toStored(next) });
		const undo: Undo = { item, index: this.index, before, fsrs: item.fsrs };
		item.fsrs = next;
		// a card still due today waits for its time (Again 1m, Hard 6m), never earlier
		const end = new Date();
		end.setHours(23, 59, 59, 999);
		if (next.due <= end) this.waiting.push(item);
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
		this.waiting = this.waiting.filter((it) => it !== u.item);
		const again = this.queue.lastIndexOf(u.item);
		if (again > u.index) this.queue.splice(again, 1);
		store.setEntry(u.item.key, u.before);
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
		if (this.mode !== 'review' || !item || this.busy) return;
		window.clearTimeout(this.disarm);
		if (!this.discardArmed) {
			this.discardArmed = true;
			this.hint?.setText(ARMED_HINT);
			this.disarm = window.setTimeout(() => {
				this.discardArmed = false;
				this.hint?.setText(isNew(item.fsrs) ? NEW_HINT : '');
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
		const more = extraQueue(items, { now, log: store.log, retrievability: (c, t) => scheduler.retrievability(c, t) });
		this.more = more;
		if (more.length) {
			// cards of today left over: keep going; otherwise only new past the cap or ahead of their day
			col.createDiv({ text: left.length ? 'Keep going?' : 'Ahead of schedule?', cls: 'revisit-muted' });
			this.drawTimes(col, (m) => this.keepGoing(m));
		}
		const links = col.createDiv({ cls: 'revisit-links' });
		links.createEl('a', { text: 'New card', cls: 'revisit-link' }).onclick = () => this.plugin.openCreate({ onSaved: () => (n ? this.show('done') : void this.begin()) });
		this.decksLink(links);
	}

	// ---- Decks ----

	private decksLink(parent: HTMLElement): void {
		parent.createEl('a', { text: 'Decks', cls: 'revisit-link' }).onclick = () => this.showDecks();
	}

	/** Opens the Decks screen, unless a session is running. */
	showDecks(): void {
		if (this.mode === 'review') return;
		if (this.starting) this.decksNext = true;
		else this.show('decks');
	}

	/** Every deck as a folder with its cards: only to look; Review always mixes them all. */
	private drawDecks(root: HTMLElement): void {
		const { store, scheduler } = this.plugin;
		const now = new Date();
		const queue = this.todayQueue();
		const decks = groupDecks(buildItems(store.cards, store.state), normalizePath(this.plugin.settings.folder), new Set(queue.map((it) => it.key)), now, (c, t) => scheduler.retrievability(c, t));
		const col = root.createDiv({ cls: 'revisit-col revisit-decks' });

		const head = col.createDiv({ cls: 'revisit-decks-today' });
		const text = head.createDiv();
		const n = queue.length;
		text.createEl('h2', { text: n ? `${n} ${n === 1 ? 'card' : 'cards'} today` : 'Nothing due today', cls: 'revisit-serif' });
		if (n) {
			const fresh = queue.filter((it) => isNew(it.fsrs)).length;
			const recent = store.log.slice(-200).map((e) => e.seconds).filter((x) => x > 0);
			const avg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 10;
			const minutes = Math.max(1, Math.round((n * avg) / 60));
			const parts = [n - fresh ? `${n - fresh} to review` : '', fresh ? `${fresh} new` : ''].filter(Boolean).join(', ');
			text.createDiv({ text: `${parts}. About ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`, cls: 'revisit-muted' });
		}
		head.createEl('button', { text: n ? 'Review' : 'Back', cls: 'mod-cta' }).onclick = () => void this.begin();

		if (!decks.length) {
			col.createDiv({ text: 'No cards yet. Select text in a note and run New card.', cls: 'revisit-muted' });
			return;
		}
		const legend = col.createDiv({ cls: 'revisit-decks-legend' });
		for (const [cls, label] of [['is-new', 'New'], ['is-learning', 'Learning'], ['is-review', 'Review']]) legend.createSpan({ text: label, cls });

		if (!decks.some((d) => d.file === this.openDeck)) this.openDeck = decks[0]?.file ?? '';
		const grid = col.createDiv({ cls: 'revisit-decks-grid' });
		for (const d of decks) {
			const total = d.rows.length;
			const f = grid.createEl('button', { cls: 'revisit-folder' + (d.file === this.openDeck ? ' is-open' : ''), attr: { 'aria-expanded': String(d.file === this.openDeck) } });
			f.createDiv({ text: d.name, cls: 'revisit-folder-name revisit-serif' });
			f.createDiv({ text: `${total} ${total === 1 ? 'card' : 'cards'}`, cls: 'revisit-folder-count' });
			const bar = f.createDiv({ cls: 'revisit-folder-bar' });
			for (const [cls, k] of [['is-new', d.counts.new], ['is-learning', d.counts.learning], ['is-review', d.counts.review]] as const) bar.createSpan({ cls }).style.width = `${(k / total) * 100}%`;
			f.createDiv({ text: d.today ? `${d.today} due today` : 'Nothing today', cls: 'revisit-folder-due' + (d.today ? ' is-due' : '') });
			f.onclick = () => {
				this.openDeck = d.file;
				this.show('decks');
			};
		}

		const open = decks.find((d) => d.file === this.openDeck);
		if (!open) return;
		const sec = col.createDiv({ cls: 'revisit-deck' });
		const h = sec.createDiv({ cls: 'revisit-deck-head' });
		h.createEl('h3', { text: open.name, cls: 'revisit-serif' });
		h.createSpan({ text: open.folder ? `${open.folder}/${open.name}.md` : `${open.name}.md`, cls: 'revisit-muted' });
		const table = sec.createDiv({ cls: 'revisit-deck-list' }).createEl('table');
		const tr = table.createEl('tr');
		for (const t of ['Card', 'State', 'Back in', 'Memory']) tr.createEl('th', { text: t });
		const STATE_NAME: Record<number, [string, string]> = { [State.New]: ['New', 'is-new'], [State.Learning]: ['Learning', 'is-learning'], [State.Review]: ['Review', 'is-review'], [State.Relearning]: ['Relearning', 'is-learning'] };
		for (const r of open.rows) {
			const row = table.createEl('tr');
			row.createEl('td', { text: r.front, cls: 'revisit-deck-q revisit-serif' });
			const [name, cls] = STATE_NAME[r.state] ?? ['New', 'is-new'];
			row.createEl('td').createSpan({ text: name, cls: `revisit-pill ${cls}` });
			const when = r.today ? 'today' : r.due ? `in ${formatInterval(r.due.getTime() - now.getTime())}` : '—';
			row.createEl('td', { text: when, cls: r.today ? 'is-due' : '' });
			const m = row.createEl('td');
			if (r.memory === null) m.setText('—');
			else {
				const mem = m.createDiv({ cls: 'revisit-mem' + (r.memory < 0.85 ? ' is-low' : '') });
				mem.createDiv({ cls: 'revisit-mem-track' }).createSpan().style.width = `${Math.round(r.memory * 100)}%`;
				mem.createSpan({ text: `${Math.round(r.memory * 100)}%` });
			}
		}
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.disarm);
		this.contentEl.empty();
	}
}
