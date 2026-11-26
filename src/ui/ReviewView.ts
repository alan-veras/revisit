import { ItemView, MarkdownRenderer, Menu, Modal, Modifier, normalizePath, Notice, Platform, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { groupDecks } from '../core/decks';
import { estimateMinutes, parseMinutes } from '../core/estimate';
import { minutesLeft, shiftClock } from '../core/pause';
import { formatInterval, freshCard, isNew, State, toStored } from '../core/scheduler';
import { buildItems, buildQueue, extraQueue, faces, itemsFor, nextCardLabel, QueueItem } from '../core/queue';
import { GRADES, Grade, CardState } from '../core/types';
import type RevisitPlugin from '../main';

export const VIEW_TYPE_REVIEW = 'revisit-review';

const ALL = '*';
/** rows drawn in an opened folder; the rest is only counted */
const MAX_ROWS = 200;
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Mode = 'start' | 'review' | 'done' | 'decks';

// the wording is the design (lowercase, with the key letter), so it is joined here instead of written as one literal
const NEW_HINT = ['new', 'D discards'].join(' · ');
const ARMED_HINT = ['press', 'D again to delete this card'].join(' ');
const TIMES = [2, 5, 10];
/** the last custom length, kept per device */
const CUSTOM_KEY = 'revisit-minutes';
const CUSTOM_DEFAULT = 15;
const RESUME_TEXT = Platform.isMobile ? 'Tap to resume' : ['P', 'or tap to resume'].join(' ');
const FLIP_TEXT = Platform.isMobile ? 'Tap to flip' : ['Space', 'or click to flip'].join(' ');

/** The keys the review answers to, shown by the ? button. */
const KEYS: [string, string][] = [
	['4 5', 'Custom time, time to clear (start)'],
	['Space', 'Flip the card'],
	['1 2 3 4', 'Again, Hard, Good, Easy'],
	['P', 'Pause or resume'],
	['E', 'Edit the card'],
	['O', 'Open the source note'],
	['D D', 'Delete the card'],
	[(Platform.isMacOS ? 'Cmd' : 'Ctrl') + ' Z', 'Undo the last grade'],
	['?', 'Show or hide this help'],
];

interface Undo {
	item: QueueItem;
	index: number;
	/** the session it was graded in: a queue rebuilt since then puts the card back elsewhere */
	gen: number;
	before: CardState | undefined;
	fsrs: QueueItem['fsrs'];
}

/** One view, three moments: Start (pick the time), Review, Done. */
export class ReviewView extends ItemView {
	private mode: Mode = 'start';
	/** the folder opened on the Decks screen: a card file, ALL, or '' for the folders */
	private openDeck = '';
	/** the deck being reviewed (card file); null reviews every deck */
	private deck: string | null = null;
	/** the next Decks drawing animates the opened folder out of this box */
	private openFrom: DOMRect | null = null;
	/** begin() is reading the cards; Decks asked meanwhile waits for it */
	private starting = false;
	private decksNext = false;
	/** bumped by begin() and every session start: a begin() that finishes late sees it changed and stops */
	private gen = 0;
	/** undo just put a card back: the waiting cards let it be shown first */
	private holdWaiting = false;
	private queue: QueueItem[] = [];
	private index = 0;
	private flipped = false;
	private shownAt = 0;
	private startedAt = 0;
	private endsAt = 0;
	/** when the review was paused; 0 while it runs */
	private pausedAt = 0;
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
		// a key typed into a field stays with the field
		const typing = (el: Node | null) => !!el && (el.instanceOf(HTMLInputElement) || el.instanceOf(HTMLTextAreaElement));
		const on = (key: string, fn: () => void, mods: Modifier[] = []) =>
			scope.register(mods, key, (evt) => {
				if (typing(evt.target as Node | null)) return true;
				fn();
				return false;
			});
		['1', '2', '3', '4', '5'].forEach((k) => on(k, () => this.digit(Number(k))));
		on(' ', () => this.flip());
		on('p', () => this.togglePause());
		on('e', () => this.editCard());
		on('o', () => this.openSource());
		on('d', () => void this.discard());
		on('z', () => void this.undoLast(), ['Mod']);
		on('?', () => this.toggleHelp(), ['Shift']);
		on('Enter', () => this.enter());
		on('Escape', () => this.escape());
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
		const gen = ++this.gen;
		this.starting = true;
		try {
			await this.plugin.refresh();
		} finally {
			this.starting = false;
		}
		// a session started while the cards were read (Keep going on Done): it is not thrown away
		if (gen !== this.gen) {
			this.decksNext = false;
			return;
		}
		this.graded.clear();
		this.undo = [];
		this.waiting = [];
		this.deck = null;
		this.openDeck = '';
		this.queue = this.todayQueue();
		if (this.decksNext) {
			this.decksNext = false;
			this.show('decks');
		} else if (this.queue.length) this.show('start');
		else this.show('done');
	}

	/** The cards of `deck` (a card file), or of every deck. */
	private items(deck: string | null = this.deck): QueueItem[] {
		const { store } = this.plugin;
		return itemsFor(buildItems(store.cards, store.state), deck);
	}

	private todayQueue(deck: string | null = this.deck): QueueItem[] {
		const { store, scheduler } = this.plugin;
		return buildQueue(this.items(deck), { now: new Date(), log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
	}

	private aheadQueue(deck: string | null = this.deck): QueueItem[] {
		const { store, scheduler } = this.plugin;
		return extraQueue(this.items(deck), { now: new Date(), log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
	}

	private show(mode: Mode): void {
		this.mode = mode;
		const root = this.contentEl;
		root.empty();
		// a screen drawn anew is never paused
		this.pausedAt = 0;
		root.removeClass('is-paused');
		root.addClass('revisit');
		root.toggleClass('is-touch', Platform.isMobile);
		this.bar = null;
		if (mode === 'start') this.drawStart(root);
		else if (mode === 'review') this.drawCard(root);
		else if (mode === 'decks') this.drawDecks(root);
		else this.drawDone(root);
		// the last card graded: drawCard already moved on to Done, which drew itself
		if (this.mode !== mode) return;
		if (mode === 'review' && Platform.isMobile) this.drawMenu(root);
		else if ((mode === 'start' || mode === 'review') && !Platform.isMobile) this.drawHelp(root);
		this.plugin.updateStatus();
	}

	// ---- Start ----

	private drawStart(root: HTMLElement): void {
		const col = root.createDiv({ cls: 'revisit-col revisit-center' });
		col.createEl('h2', { text: 'How much time today?', cls: 'revisit-serif' });
		this.drawTimes(col, (m) => this.pickTime(m));
		this.drawExtraTimes(col);
	}

	/** Under the three lengths, quieter: a length of your own, and the time today's cards ask for. */
	private drawExtraTimes(col: HTMLElement): void {
		const row = col.createDiv({ cls: 'revisit-times-extra' });
		const last = this.lastCustom();
		const custom = row.createEl('button', { text: last === null ? 'Custom' : `Custom · ${last} min`, cls: 'revisit-custom-btn' + (TIMES.includes(this.minutes) ? '' : ' mod-cta') });
		if (!Platform.isMobile) custom.createSpan({ text: '4', cls: 'revisit-key' });
		custom.onclick = () => this.editCustom(custom);
		const clear = this.clearMinutes();
		if (clear === null) return;
		const b = row.createEl('button', { text: `~${clear} min to clear` });
		if (!Platform.isMobile) b.createSpan({ text: '5', cls: 'revisit-key' });
		b.onclick = () => this.pickTime(clear);
	}

	private lastCustom(): number | null {
		const saved: unknown = this.app.loadLocalStorage(CUSTOM_KEY);
		return typeof saved === 'number' || typeof saved === 'string' ? parseMinutes(String(saved)) : null;
	}

	/** Minutes to go through today's cards of every deck; null when there are none. */
	private clearMinutes(): number | null {
		return estimateMinutes(this.todayQueue(null).length, this.plugin.store.log);
	}

	/** The Custom button turns into a minutes field: Enter or OK picks, Esc gives the button back. */
	private editCustom(button: HTMLElement): void {
		const box = createDiv({ cls: 'revisit-custom' });
		const input = box.createEl('input', { type: 'number', attr: { inputmode: 'numeric', min: '1', max: '180', 'aria-label': 'Minutes' } });
		input.value = String(this.lastCustom() ?? CUSTOM_DEFAULT);
		box.createSpan({ text: 'min', cls: 'revisit-muted' });
		const ok = box.createEl('button', { text: 'OK' });
		const confirm = () => {
			const minutes = parseMinutes(input.value);
			if (minutes === null) return input.focus();
			this.app.saveLocalStorage(CUSTOM_KEY, minutes);
			this.pickTime(minutes);
		};
		ok.onclick = confirm;
		input.onkeydown = (e) => {
			if (e.key !== 'Enter' && e.key !== 'Escape') return;
			e.preventDefault();
			if (e.key === 'Enter') confirm();
			else this.show('start');
		};
		button.replaceWith(box);
		input.focus();
		input.select();
	}

	/** The time is picked: the decks come next. */
	private pickTime(minutes: number): void {
		this.minutes = minutes;
		this.openDeck = '';
		this.show('decks');
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
		// a waiting card that Keep going already holds is asked once, from the fresh queue
		const keys = new Set(this.more.map((it) => it.key));
		this.waiting = this.waiting.filter((it) => !keys.has(it.key));
		this.startSession(minutes, true);
	}

	/** `more` keeps going after Done: the count and the undo history carry on. */
	private startSession(minutes: number, more = false): void {
		this.minutes = minutes;
		this.index = 0;
		this.gen++;
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
		const hold = this.holdWaiting;
		this.holdWaiting = false;
		if (ready.length && !hold) {
			this.waiting = this.waiting.filter((it) => !ready.includes(it));
			// a card already ahead in the queue (Keep going rebuilt it) is not asked twice
			const ahead = new Set(this.queue.slice(this.index).map((it) => it.key));
			this.queue.splice(this.index, 0, ...ready.filter((it) => !ahead.has(it.key)));
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
		if (!Platform.isMobile) this.drawPauseButton(root);
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

	// ---- Pause ----

	/** A faint ⏸ under the time line, seen only when the pointer is up there. */
	private drawPauseButton(root: HTMLElement): void {
		const zone = root.createDiv({ cls: 'revisit-pause-zone' });
		const btn = zone.createEl('button', { cls: 'revisit-pause-btn clickable-icon', attr: { 'aria-label': 'Pause' } });
		setIcon(btn, 'pause');
		btn.onclick = () => this.pause();
	}

	private togglePause(): void {
		if (this.pausedAt) this.resume();
		else this.pause();
	}

	/** The card is hidden, not redrawn: it comes back on the same side. */
	private pause(): void {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || this.busy || this.pausedAt) return;
		this.pausedAt = Date.now();
		// a delete waiting for its second D is forgotten
		window.clearTimeout(this.disarm);
		this.discardArmed = false;
		this.hint?.setText(isNew(item.fsrs) ? NEW_HINT : '');
		this.contentEl.addClass('is-paused');
		const cover = this.contentEl.createDiv({ cls: 'revisit-paused' });
		cover.createDiv({ text: 'Paused', cls: 'revisit-paused-title revisit-serif' });
		cover.createDiv({ text: `${minutesLeft(this.endsAt, this.pausedAt)} min left · ${RESUME_TEXT}`, cls: 'revisit-muted' });
		cover.onclick = () => this.resume();
	}

	private resume(): void {
		if (!this.pausedAt) return;
		const clock = shiftClock({ startedAt: this.startedAt, endsAt: this.endsAt, shownAt: this.shownAt }, Date.now() - this.pausedAt);
		({ startedAt: this.startedAt, endsAt: this.endsAt, shownAt: this.shownAt } = clock);
		this.pausedAt = 0;
		this.contentEl.removeClass('is-paused');
		this.contentEl.querySelector('.revisit-paused')?.remove();
		this.tick();
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
			menu.addItem((i) => i.setTitle('Pause').setIcon('pause').onClick(() => this.pause()));
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
		if (this.bar && this.mode === 'review' && !this.pausedAt) this.bar.style.width = `${Math.min(100, ((Date.now() - this.startedAt) / (this.endsAt - this.startedAt)) * 100)}%`;
	}

	private flip(): void {
		if (this.mode === 'decks') return this.enter();
		if (this.mode !== 'review' || this.busy || this.pausedAt) return;
		this.flipped = !this.flipped;
		this.contentEl.toggleClass('is-flipped', this.flipped);
	}

	private digit(n: number): void {
		if (this.mode === 'start' && n <= 3) this.pickTime(TIMES[n - 1] as number);
		else if (this.mode === 'start' && n === 4) {
			// the button, or the field it already turned into
			const el = this.contentEl.querySelector<HTMLElement>('.revisit-custom-btn, .revisit-custom input');
			el?.focus();
			el?.click();
		} else if (this.mode === 'start') {
			const clear = this.clearMinutes();
			if (clear !== null) this.pickTime(clear);
		}
		else if (this.mode === 'decks' && !this.openDeck && n === 1) this.openFolder(ALL);
		else if (this.mode === 'done' && n <= 3) this.keepGoing(TIMES[n - 1] as number);
		else if (this.mode === 'review' && this.flipped && n <= 4) void this.grade(n as Grade);
	}

	private async grade(grade: Grade): Promise<void> {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || !this.preview || this.busy || this.pausedAt) return;
		this.busy = true;
		this.flipped = false;
		this.contentEl.removeClass('is-flipped');
		const { store } = this.plugin;
		// scheduled from the moment of the grade: a card left open for a while is not dated back
		const now = new Date();
		const next = this.plugin.scheduler.preview(item.fsrs ?? freshCard(now), now)[grade].card;
		const entry = { id: item.key, t: now.toISOString(), grade, seconds: Math.round((Date.now() - this.shownAt) / 1000), type: item.card.type, new: isNew(item.fsrs), extra: false, state: item.fsrs?.state ?? 0 };
		const before = store.state[item.key];
		store.setEntry(item.key, { ...before, st: before?.st ?? 'active', fsrs: toStored(next) });
		const undo: Undo = { item, index: this.index, gen: this.gen, before, fsrs: item.fsrs };
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
		if (this.busy || this.pausedAt || (this.mode !== 'review' && this.mode !== 'done')) return;
		const u = this.undo.pop();
		if (!u) return;
		this.busy = true;
		const { store } = this.plugin;
		this.waiting = this.waiting.filter((it) => it.key !== u.item.key);
		// the same queue: the card goes back to its place; a queue rebuilt by Keep going: it comes next
		const same = u.gen === this.gen && this.queue[u.index] === u.item;
		const at = same ? u.index : Math.min(this.index, this.queue.length);
		this.queue = this.queue.filter((it, i) => i <= at - (same ? 0 : 1) || it.key !== u.item.key);
		if (!same) this.queue.splice(at, 0, u.item);
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
		this.index = at;
		this.holdWaiting = true;
		this.show('review');
	}

	private editCard(): void {
		const item = this.queue[this.index];
		if (this.mode === 'review' && item && !this.pausedAt) this.plugin.openCreate({ card: item.card, onSaved: () => this.refreshCards() });
	}

	/** Cards edited from the session: the queue keeps its order, with the fresh text. */
	private refreshCards(): void {
		const byId = new Map(this.plugin.store.cards.map((c) => [c.id, c]));
		[...this.queue, ...this.waiting].forEach((it) => (it.card = byId.get(it.card.id) ?? it.card));
		this.show('review');
	}

	private openSource(): void {
		const item = this.queue[this.index];
		const target = /\[\[([^\]|]+)/.exec(item?.card.source ?? '')?.[1];
		if (this.mode === 'review' && target && !this.pausedAt) void this.app.workspace.openLinkText(target, item?.card.file ?? '', 'split');
	}

	/** D on a new card: asks once more, then deletes it. */
	private async discard(): Promise<void> {
		const item = this.queue[this.index];
		if (this.mode !== 'review' || !item || this.busy || this.pausedAt) return;
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
			// the next D asks again
			this.discardArmed = false;
			this.hint?.setText(isNew(item.fsrs) ? NEW_HINT : '');
			return;
		} finally {
			this.busy = false;
		}
		// copies of it earlier in the queue (graded, then back from waiting) go too: the index moves back by as many
		const gone = (it: QueueItem) => it.card.id === item.card.id;
		this.index -= this.queue.slice(0, this.index).filter(gone).length;
		this.queue = this.queue.filter((it) => !gone(it));
		this.waiting = this.waiting.filter((it) => it.card.id !== item.card.id);
		// the queue shifted and the card is gone: earlier grades can no longer be undone safely
		this.undo = [];
		this.show('review');
	}

	// ---- Done ----

	private finish(): void {
		this.show('done');
	}

	private drawDone(root: HTMLElement): void {
		const { store, scheduler } = this.plugin;
		const now = new Date();
		const items = this.items();
		const left = buildQueue(items, { now, log: store.log, retrievability: (c, n) => scheduler.retrievability(c, n) });
		const col = root.createDiv({ cls: 'revisit-col revisit-center' });
		const n = this.graded.size;
		col.createEl('h2', { text: n ? `Done. ${n} ${n === 1 ? 'card' : 'cards'}.` : 'All caught up.', cls: 'revisit-serif' });
		const next = left.length ? null : nextCardLabel(items, now);
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

	/** Opens the folders, unless a session is running. */
	showDecks(): void {
		if (this.mode === 'review') return;
		this.openDeck = '';
		if (this.starting) this.decksNext = true;
		else this.show('decks');
	}

	private openFolder(file: string, from: HTMLElement | null = null): void {
		this.openFrom = from?.getBoundingClientRect() ?? null;
		this.openDeck = file;
		this.show('decks');
	}

	/** Enter: resume when paused, All decks on the folders, Start in an opened folder. */
	private enter(): void {
		if (this.pausedAt) return this.resume();
		if (this.mode !== 'decks') return;
		if (!this.openDeck) this.openFolder(ALL, this.contentEl.querySelector<HTMLElement>('.revisit-folder.is-all'));
		else this.reviewDeck();
	}

	private escape(): void {
		if (this.mode === 'decks' && this.openDeck) this.showDecks();
	}

	/** Reviews the opened folder: today's cards, or ahead of schedule when it has none. */
	private reviewDeck(): void {
		const deck = this.openDeck === ALL ? null : this.openDeck;
		const queue = this.todayQueue(deck);
		const next = queue.length ? queue : this.aheadQueue(deck);
		if (!next.length) return;
		this.deck = deck;
		this.queue = next;
		this.startSession(this.minutes);
	}

	private drawDecks(root: HTMLElement): void {
		if (this.openDeck) return this.drawDeck(root);
		const { store, scheduler } = this.plugin;
		const decks = groupDecks(this.items(null), normalizePath(this.plugin.settings.folder), new Set(), new Date(), (c, t) => scheduler.retrievability(c, t));
		const col = root.createDiv({ cls: 'revisit-col revisit-decks' });
		if (!store.cards.length) {
			col.createDiv({ text: 'No cards yet. Select text in a note and run New card.', cls: 'revisit-muted' });
			return;
		}
		const grid = col.createDiv({ cls: 'revisit-decks-grid' });
		const folders = [{ file: ALL, name: 'All decks' }, ...decks];
		folders.forEach((d, i) => {
			const f = grid.createEl('button', { text: d.name, cls: 'revisit-folder revisit-serif' + (d.file === ALL ? ' is-all' : '') });
			f.onclick = () => this.openFolder(d.file, f);
			if (!still()) f.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: i * 40, easing: 'ease-out', fill: 'backwards' });
		});
	}

	/** One folder opened: its cards, and Start. */
	private drawDeck(root: HTMLElement): void {
		const { scheduler } = this.plugin;
		const now = new Date();
		const deck = this.openDeck === ALL ? null : this.openDeck;
		const queue = this.todayQueue(deck);
		const decks = groupDecks(this.items(deck), normalizePath(this.plugin.settings.folder), new Set(queue.map((it) => it.key)), now, (c, t) => scheduler.retrievability(c, t));
		if (deck && !decks.length) return this.showDecks();
		const panel = root.createDiv({ cls: 'revisit-deck' });
		const head = panel.createDiv({ cls: 'revisit-deck-head' });
		const back = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Back to decks' } });
		setIcon(back, 'arrow-left');
		back.onclick = () => this.showDecks();
		head.createEl('h3', { text: deck ? (decks[0]?.name ?? '') : 'All decks', cls: 'revisit-serif' });
		// Start sits by the title, so a deck of a thousand cards never hides it
		const ahead = queue.length ? [] : this.aheadQueue(deck);
		if (queue.length || ahead.length) {
			const go = head.createEl('button', { text: queue.length ? `Start · ${this.minutes} min` : 'Review ahead', cls: 'revisit-deck-go' + (queue.length ? ' mod-cta' : '') });
			go.onclick = () => this.reviewDeck();
		} else head.createDiv({ text: 'Nothing to review', cls: 'revisit-muted revisit-deck-go' });
		const list = panel.createDiv({ cls: 'revisit-deck-rows' });
		const NAME: Record<number, [string, string]> = { [State.New]: ['New', 'is-new'], [State.Learning]: ['Learning', 'is-learning'], [State.Review]: ['Review', 'is-review'], [State.Relearning]: ['Relearning', 'is-learning'] };
		// today first, then the soonest back; new cards last
		const rank = (r: { today: boolean; due: Date | null }) => (r.today ? -Infinity : (r.due?.getTime() ?? Infinity));
		const rows = decks.flatMap((d) => d.rows).sort((a, b) => rank(a) - rank(b));
		for (const r of rows.slice(0, MAX_ROWS)) {
			const row = list.createDiv({ cls: 'revisit-deck-row' });
			row.createDiv({ text: r.front, cls: 'revisit-deck-q revisit-serif' });
			const info = row.createDiv({ cls: 'revisit-deck-info' });
			const [name, cls] = NAME[r.state] ?? ['New', 'is-new'];
			info.createSpan({ text: name, cls: `revisit-dot ${cls}` });
			info.createSpan({ text: r.today ? 'today' : r.due ? `in ${formatInterval(r.due.getTime() - now.getTime())}` : '—', cls: r.today ? 'is-due' : '' });
			info.createSpan({ text: r.memory === null ? '—' : `${Math.round(r.memory * 100)}%` });
		}
		if (rows.length > MAX_ROWS) list.createDiv({ text: `and ${rows.length - MAX_ROWS} more`, cls: 'revisit-muted revisit-deck-more' });

		const from = this.openFrom;
		this.openFrom = null;
		if (still()) return;
		if (from) {
			const to = panel.getBoundingClientRect();
			if (to.width && to.height) panel.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
		}
		[head, ...Array.from(list.children).slice(0, 20)].forEach((c, i) => {
			c.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: (from ? 200 : 0) + Math.min(i, 20) * 30, easing: 'ease-out', fill: 'backwards' });
		});
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.disarm);
		this.pausedAt = 0;
		this.contentEl.removeClass('is-paused');
		this.contentEl.empty();
	}
}
