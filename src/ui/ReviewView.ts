import { ItemView, MarkdownRenderer, Menu, Modal, Modifier, normalizePath, Notice, Platform, Scope, setIcon, WorkspaceLeaf } from 'obsidian';
import { browseOrder } from '../core/browse';
import { childDecks, crumbs, deckName, deckOf, groupDecks, nearestDeck, parentDeck, subdeckName } from '../core/decks';
import { estimateMinutes, parseMinutes } from '../core/estimate';
import { minutesLeft, shiftClock } from '../core/pause';
import { freshCard, isNew, toStored } from '../core/scheduler';
import { buildItems, buildQueue, extraQueue, faces, itemsFor, nextCardLabel, QueueItem } from '../core/queue';
import { GRADES, Grade, Card, CardState } from '../core/types';
import type RevisitPlugin from '../main';
import { DeckPicker } from './DeckPicker';
import { CardGrid, GridCard } from './CardGrid';

export const VIEW_TYPE_REVIEW = 'revisit-review';

const ALL = '*';
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

type Mode = 'review' | 'decks' | 'done';

// the wording is the design (lowercase, with the key letter), so it is joined here instead of written as one literal
const NEW_HINT = ['new', 'D discards'].join(' · ');
const ARMED_HINT = ['press', 'D again to delete this card'].join(' ');
const TIMES = [2, 5, 10];
/** the length picked last, preselected the next time; kept per device */
const LAST_KEY = 'revisit-last-time';
/** the last custom length, kept per device */
const CUSTOM_KEY = 'revisit-minutes';
const CUSTOM_DEFAULT = 15;
const RESUME_TEXT = Platform.isMobile ? 'Tap to resume' : ['P', 'or tap to resume'].join(' ');
const FLIP_TEXT = Platform.isMobile ? 'Tap to flip' : ['Space', 'or click to flip'].join(' ');

/** The keys the review answers to, shown by the ? button. */
/** what the arrows move between on the folders */
const NAV = '.revisit-folder, .revisit-card, button.revisit-deck-go';

const KEYS: [string, string][] = [
	['1 2 3 4 5', '2, 5, 10 min, custom, time to clear (after Start)'],
	['Space', 'Flip the card'],
	['1 2 3 4', 'Again, Hard, Good, Easy'],
	['P', 'Pause or resume'],
	['Esc', 'Back: leave the session, close the times, go up a deck'],
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

/** One view, three moments: Decks (home: pick what, then how long), Review, Done. */
export class ReviewView extends ItemView {
	private mode: Mode = 'decks';
	/** the Decks screen the session was started from; leaving it goes back there */
	private origin = '';
	/** the folder opened on the Decks screen: a deck path (`AWS/EC2`), ALL, or '' for the folders */
	private openDeck = '';
	/** the deck being reviewed (deck path, with its subdecks); null reviews every deck */
	private deck: string | null = null;
	/** the next Decks drawing animates the opened folder out of this box */
	private openFrom: DOMRect | null = null;
	/** the next Decks drawing has no entrance: going up a level, or cards moved underneath */
	private quiet = false;
	/** begin() is reading the cards: it draws Decks when done */
	private starting = false;
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
	/** the length of the session; Keep going offers it again */
	private minutes = TIMES[0] as number;
	/** what Keep going would review, worked out when Done is drawn */
	private more: QueueItem[] = [];
	/** the flip cards of the opened folder */
	private grid: CardGrid | null = null;
	private answersBtn: HTMLElement | null = null;

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
		// outside the folders the arrows keep their own job (scrolling a long answer)
		for (const dir of ['Left', 'Right', 'Up', 'Down'] as const)
			scope.register([], `Arrow${dir}`, (evt) => {
				if (this.mode !== 'decks' || typing(evt.target as Node | null)) return true;
				this.move(dir);
				return false;
			});
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

	/** Home: reads the cards again and shows the decks. */
	async begin(): Promise<void> {
		const gen = ++this.gen;
		this.starting = true;
		try {
			await this.plugin.refresh();
		} finally {
			this.starting = false;
		}
		// a session started while the cards were read (Keep going on Done): it is not thrown away
		if (gen !== this.gen) return;
		this.graded.clear();
		this.undo = [];
		this.waiting = [];
		this.deck = null;
		this.openDeck = '';
		this.queue = [];
		this.show('decks');
	}

	private get base(): string {
		return normalizePath(this.plugin.settings.folder);
	}

	/** The cards of `deck` and its subdecks, or of every deck. */
	private items(deck: string | null = this.deck): QueueItem[] {
		const { store } = this.plugin;
		return itemsFor(buildItems(store.cards, store.state), deck, this.base);
	}

	/** Deck paths that have something to show: a deck of suspended cards only is not listed. */
	private deckPaths(): string[] {
		return this.items(null)
			.filter((it) => !it.suspended)
			.map((it) => deckOf(it.card.file ?? '', this.base));
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
		this.dropGrid();
		root.empty();
		// a screen drawn anew is never paused
		this.pausedAt = 0;
		root.removeClass('is-paused');
		root.addClass('revisit');
		root.toggleClass('is-touch', Platform.isMobile);
		this.bar = null;
		if (mode === 'review') this.drawCard(root);
		else if (mode === 'decks') this.drawDecks(root);
		else this.drawDone(root);
		// the last card graded: drawCard already moved on to Done, which drew itself
		if (this.mode !== mode) return;
		if (mode === 'review' && Platform.isMobile) this.drawMenu(root);
		else if (!Platform.isMobile && (mode === 'review' || (mode === 'decks' && !this.openDeck))) this.drawHelp(root);
		this.plugin.updateStatus();
	}

	// ---- How much time? ----

	private asking(): HTMLElement | null {
		return this.contentEl.querySelector<HTMLElement>('.revisit-ask');
	}

	/** The times open under the title of the deck, the one picked last already selected: Enter starts. */
	private askTime(): void {
		const head = this.contentEl.querySelector<HTMLElement>('.revisit-deck-head');
		if (!head || this.asking() || !this.deckQueue().length) return;
		const saved: unknown = this.app.loadLocalStorage(LAST_KEY);
		this.minutes = parseMinutes(String(saved)) ?? (TIMES[0] as number);
		const box = createDiv({ cls: 'revisit-ask' });
		head.after(box);
		box.createDiv({ text: 'How much time?', cls: 'revisit-muted' });
		this.drawTimes(box, (m) => this.pickTime(m));
		this.drawExtraTimes(box);
		box.querySelector<HTMLElement>('button.mod-cta')?.focus();
	}

	private closeAsk(): void {
		this.asking()?.remove();
		this.contentEl.querySelector<HTMLElement>('button.revisit-deck-go')?.focus();
	}

	/** Under the three lengths, quieter: a length of your own, and the time the deck's cards of today ask for. */
	private drawExtraTimes(col: HTMLElement): void {
		const row = col.createDiv({ cls: 'revisit-times-extra' });
		const last = this.lastCustom();
		const custom = row.createEl('button', { text: last === null ? 'Custom' : `Custom · ${last} min`, cls: 'revisit-custom-btn' + (TIMES.includes(this.minutes) ? '' : ' mod-cta') });
		if (!Platform.isMobile) custom.createSpan({ text: '4', cls: 'revisit-key' });
		custom.onclick = () => this.editCustom(custom);
		const clear = this.clearMinutes();
		if (clear === null) return;
		const b = row.createEl('button', { text: `~${clear} min to clear`, cls: 'revisit-clear-btn' });
		if (!Platform.isMobile) b.createSpan({ text: '5', cls: 'revisit-key' });
		b.onclick = () => this.pickTime(clear);
	}

	private lastCustom(): number | null {
		const saved: unknown = this.app.loadLocalStorage(CUSTOM_KEY);
		return typeof saved === 'number' || typeof saved === 'string' ? parseMinutes(String(saved)) : null;
	}

	/** Minutes to go through today's cards of the opened deck; null when there are none. */
	private clearMinutes(): number | null {
		return estimateMinutes(this.todayQueue(this.openedDeck()).length, this.plugin.store.log);
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
			else {
				this.closeAsk();
				this.askTime();
			}
		};
		button.replaceWith(box);
		input.focus();
		input.select();
	}

	private openedDeck(): string | null {
		return this.openDeck === ALL ? null : this.openDeck;
	}

	/** What Start asks in the opened deck: today's cards, or ahead of schedule when it has none. */
	private deckQueue(): QueueItem[] {
		const deck = this.openedDeck();
		const queue = this.todayQueue(deck);
		return queue.length ? queue : this.aheadQueue(deck);
	}

	/** The time is picked: the session of the opened deck starts. */
	private pickTime(minutes: number): void {
		const queue = this.deckQueue();
		if (!queue.length) return;
		// the time to clear changes every day: only a length that has its own button is remembered
		if (TIMES.includes(minutes) || minutes === this.lastCustom()) this.app.saveLocalStorage(LAST_KEY, minutes);
		this.origin = this.openDeck;
		this.deck = this.openedDeck();
		this.queue = queue;
		this.startSession(minutes);
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
		cover.createEl('button', { text: 'End session', cls: 'revisit-end' }).onclick = (ev) => {
			// the cover behind it resumes on click
			ev.stopPropagation();
			this.endSession();
		};
	}

	/** Leaves a session, started by mistake or not, for the deck it started from. Grades given are saved already. */
	private endSession(): void {
		this.graded.clear();
		this.undo = [];
		this.waiting = [];
		this.queue = [];
		this.backToOrigin();
	}

	private backToOrigin(): void {
		this.deck = null;
		this.openDeck = this.origin;
		this.quiet = true;
		this.show('decks');
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
		if (!(await this.askDelete())) return;
		this.discardArmed = true;
		await this.discard();
	}

	private askDelete(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			const m = new Modal(this.app);
			m.titleEl.setText('Delete this card?');
			const row = m.contentEl.createDiv({ cls: 'modal-button-container' });
			row.createEl('button', { text: 'Delete', cls: 'mod-warning' }).onclick = () => (resolve(true), m.close());
			row.createEl('button', { text: 'Cancel' }).onclick = () => m.close();
			m.onClose = () => resolve(false);
			m.open();
		});
	}

	private toggleHelp(): void {
		this.contentEl.toggleClass('is-help', !this.contentEl.hasClass('is-help'));
	}

	private tick(): void {
		if (this.bar && this.mode === 'review' && !this.pausedAt) this.bar.style.width = `${Math.min(100, ((Date.now() - this.startedAt) / (this.endsAt - this.startedAt)) * 100)}%`;
	}

	/** The folder, card or Start the arrows are on, if any. */
	private focused(): HTMLElement | null {
		const el = this.contentEl.doc.activeElement as HTMLElement | null;
		return el && this.contentEl.contains(el) && el.matches(this.nav()) ? el : null;
	}

	/** With the times open, the arrows stay among them. */
	private nav(): string {
		return this.asking() ? '.revisit-ask button' : NAV;
	}

	/** Left and Right go in reading order; Up and Down to the closest one of the next row. */
	private move(dir: 'Left' | 'Right' | 'Up' | 'Down'): void {
		const all = Array.from(this.contentEl.querySelectorAll<HTMLElement>(this.nav()));
		const from = this.focused();
		let to: HTMLElement | undefined;
		// the first arrow goes to the first folder or card, not to Start
		if (!from) to = all.find((el) => !el.matches('.revisit-deck-go')) ?? all[0];
		else if (dir === 'Left' || dir === 'Right') to = all[all.indexOf(from) + (dir === 'Right' ? 1 : -1)];
		else {
			const a = from.getBoundingClientRect();
			const sign = dir === 'Down' ? 1 : -1;
			const beyond = all
				.map((el) => ({ el, r: el.getBoundingClientRect() }))
				.filter(({ r }) => (dir === 'Down' ? r.top >= a.bottom - 1 : r.bottom <= a.top + 1))
				.map(({ el, r }) => ({ el, row: sign * (r.top - a.top), off: Math.abs(r.left + r.width / 2 - a.left - a.width / 2) }));
			const row = Math.min(...beyond.map((b) => b.row));
			to = beyond.filter((b) => b.row - row < 20).sort((x, y) => x.off - y.off)[0]?.el;
		}
		to?.focus();
		to?.scrollIntoView({ block: 'nearest' });
	}

	private flip(): void {
		const on = this.mode === 'decks' ? this.focused() : null;
		if (on) return on.click();
		// an opened folder turns its cards; on the folders, Space opens All decks
		if (this.mode === 'decks') return this.openDeck ? this.toggleAnswers() : this.enter();
		if (this.mode !== 'review' || this.busy || this.pausedAt) return;
		this.flipped = !this.flipped;
		this.contentEl.toggleClass('is-flipped', this.flipped);
	}

	private digit(n: number): void {
		if (this.mode === 'decks' && this.asking()) {
			if (n <= 3) return this.pickTime(TIMES[n - 1] as number);
			// the button, or the field it already turned into; `5` is the time to clear
			const el = this.contentEl.querySelector<HTMLElement>(n === 4 ? '.revisit-custom-btn, .revisit-custom input' : '.revisit-clear-btn');
			el?.focus();
			el?.click();
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
		this.syncQueue();
		this.show('review');
	}

	private syncQueue(): void {
		const byId = new Map(this.plugin.store.cards.map((c) => [c.id, c]));
		[...this.queue, ...this.waiting].forEach((it) => (it.card = byId.get(it.card.id) ?? it.card));
	}

	/** Files renamed or deleted: the queue learns the new paths, and a deck that is gone gives way to its closest ancestor. */
	cardsMoved(): void {
		this.syncQueue();
		if (this.deck !== null) this.deck = nearestDeck(this.deckPaths(), this.deck) || null;
		if (this.mode !== 'decks' || this.starting) return;
		this.quiet = true;
		this.show('decks');
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
		if (!this.starting) this.show('decks');
	}

	private openFolder(deck: string, from: HTMLElement | null = null): void {
		this.openFrom = from?.getBoundingClientRect() ?? null;
		this.openDeck = deck;
		this.show('decks');
	}

	/** Enter: resume when paused, All decks on the folders, the times in an opened folder. */
	private enter(): void {
		if (this.pausedAt) return this.resume();
		if (this.mode !== 'decks' || this.starting) return;
		const on = this.focused();
		if (on) return on.click();
		if (!this.openDeck) this.openFolder(ALL, this.contentEl.querySelector<HTMLElement>('.revisit-folder.is-all'));
		else this.askTime();
	}

	private escape(): void {
		if (this.mode === 'review') return this.endSession();
		if (this.mode === 'done') return this.backToOrigin();
		if (this.asking()) return this.closeAsk();
		// the folders are home: nothing above them
		if (this.openDeck) this.goUp();
	}

	/** One level up from the opened folder. */
	private goUp(): void {
		this.jumpTo(this.openDeck === ALL ? '' : parentDeck(this.openDeck));
	}

	/** Back to an upper level, without the opening animation. */
	private jumpTo(deck: string): void {
		if (!deck) return this.showDecks();
		this.quiet = true;
		this.openDeck = deck;
		this.show('decks');
	}

	private drawDecks(root: HTMLElement): void {
		if (this.openDeck) return this.drawDeck(root);
		const quiet = this.quiet;
		this.quiet = false;
		const col = root.createDiv({ cls: 'revisit-col revisit-decks' });
		if (!this.plugin.store.cards.length) {
			col.createDiv({ text: 'No cards yet. Select text in a note and run New card.', cls: 'revisit-muted' });
			return;
		}
		const grid = col.createDiv({ cls: 'revisit-decks-grid' });
		this.drawFolders(grid, [{ path: ALL, name: 'All decks' }, ...childDecks(this.deckPaths(), '')], quiet ? null : 0);
	}

	/** Folder buttons, coming in one after the other from `delay` ms on; null draws them still. */
	private drawFolders(grid: HTMLElement, folders: { path: string; name: string }[], delay: number | null): void {
		folders.forEach((d, i) => {
			const f = grid.createEl('button', { text: d.name, cls: 'revisit-folder revisit-serif' + (d.path === ALL ? ' is-all' : '') });
			f.onclick = () => this.openFolder(d.path, f);
			if (delay !== null && !still()) f.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: delay + Math.min(i, 20) * 40, easing: 'ease-out', fill: 'backwards' });
		});
	}

	/** One folder opened: Start for everything in it, its subdecks, and its own cards. */
	private drawDeck(root: HTMLElement): void {
		const { scheduler } = this.plugin;
		const now = new Date();
		const deck = this.openDeck === ALL ? null : this.openDeck;
		const paths = this.deckPaths();
		if (deck !== null) {
			const alive = nearestDeck(paths, deck);
			if (alive !== deck) {
				// the opened deck is gone: its closest ancestor, or the folders
				this.openDeck = alive;
				this.openFrom = null;
				this.quiet = true;
				return this.drawDecks(root);
			}
		}
		const quiet = this.quiet;
		this.quiet = false;
		const from = this.openFrom;
		this.openFrom = null;
		const queue = this.todayQueue(deck);
		const panel = root.createDiv({ cls: 'revisit-deck' });
		const trail = deck === null ? [] : crumbs(deck);
		const nav = trail.length ? panel.createDiv({ cls: 'revisit-crumbs' }) : null;
		trail.forEach((c, i) => {
			if (i) nav?.createSpan({ text: '›' });
			const b = nav?.createEl('button', { text: c.label });
			if (b) b.onclick = () => this.jumpTo(c.path);
		});
		const head = panel.createDiv({ cls: 'revisit-deck-head' });
		const back = head.createEl('button', { cls: 'clickable-icon', attr: { 'aria-label': 'Back' } });
		setIcon(back, 'arrow-left');
		back.onclick = () => this.goUp();
		head.createEl('h3', { text: deck === null ? 'All decks' : deckName(deck), cls: 'revisit-serif' });
		if (deck !== null) {
			const add = head.createEl('button', { cls: 'revisit-add clickable-icon', attr: { 'aria-label': 'Add' } });
			setIcon(add, 'plus');
			add.onclick = (ev) => this.addMenu(ev, deck);
		}
		const own = deck === null ? this.items(null) : this.items(deck).filter((it) => deckOf(it.card.file ?? '', this.base) === deck);
		const decks = groupDecks(own, this.base, new Set(queue.map((it) => it.key)), now, (c, t) => scheduler.retrievability(c, t));
		const byKey = new Map(own.map((it) => [it.key, it]));
		const cards = browseOrder(decks.flatMap((d) => d.rows)).map((row): GridCard => ({ row, item: byKey.get(row.key) as QueueItem }));
		if (cards.length) {
			this.answersBtn = head.createEl('button', { text: 'Show answers', cls: 'revisit-answers' });
			this.answersBtn.onclick = () => this.toggleAnswers();
		}
		// Start sits by the title, so a deck of a thousand cards never hides it
		const ahead = queue.length ? [] : this.aheadQueue(deck);
		if (queue.length || ahead.length) {
			const go = head.createEl('button', { text: queue.length ? 'Start' : 'Review ahead', cls: 'revisit-deck-go' + (queue.length ? ' mod-cta' : '') });
			go.onclick = () => (this.asking() ? this.closeAsk() : this.askTime());
			// nothing now: say when the next card comes (a learning step in minutes, or tomorrow)
		} else head.createDiv({ text: nextCardLabel(this.items(deck), now) ?? 'Nothing to review', cls: 'revisit-muted revisit-deck-go' });

		const body = panel.createDiv({ cls: 'revisit-deck-body' });
		const subdecks = deck === null ? [] : childDecks(paths, deck);
		if (subdecks.length) this.drawFolders(body.createDiv({ cls: 'revisit-decks-grid' }), subdecks, quiet ? null : from ? 200 : 0);
		if (cards.length) this.grid = this.addChild(new CardGrid(this.app, body, cards, still, (item, ev) => this.cardMenu(item, ev)));
		else if (!subdecks.length) body.createDiv({ text: 'No cards here.', cls: 'revisit-muted' });

		if (quiet || still()) return;
		if (from) {
			const to = panel.getBoundingClientRect();
			if (to.width && to.height) panel.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})` }, { transform: 'none' }], { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
		}
		[...(nav ? [nav] : []), head, ...Array.from(this.grid?.el.children ?? []).slice(0, 20)].forEach((c, i) => {
			c.animate([{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { duration: 220, delay: (from ? 200 : 0) + Math.min(i, 20) * 30, easing: 'ease-out', fill: 'backwards' });
		});
	}

	/** Show or hide the answers of every card in the opened folder. */
	private toggleAnswers(): void {
		if (!this.grid) return;
		this.grid.toggleAll();
		this.answersBtn?.setText(this.grid.showingAll ? 'Hide answers' : 'Show answers');
	}

	private dropGrid(): void {
		if (this.grid) this.removeChild(this.grid);
		this.grid = null;
		this.answersBtn = null;
	}

	// ---- Managing a card of the grid ----

	/** The ⋯ of a card: what acts on the whole card, every highlight of a cloze included. */
	private cardMenu(item: QueueItem, ev: MouseEvent): void {
		const { card } = item;
		const target = /\[\[([^\]|]+)/.exec(card.source)?.[1];
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('Edit card').setIcon('pencil').onClick(() => this.plugin.openCreate({ card, onSaved: () => this.redrawDeck() })));
		menu.addItem((i) => i.setTitle('Move to deck…').setIcon('folder-input').onClick(() => this.moveCard(card)));
		if (target) menu.addItem((i) => i.setTitle('Open source note').setIcon('file-text').onClick(() => void this.app.workspace.openLinkText(target, card.file ?? '', 'split')));
		menu.addItem((i) => i.setTitle('Delete card').setIcon('trash').onClick(() => void this.deleteFromGrid(card)));
		menu.showAtMouseEvent(ev);
	}

	private redrawDeck(): void {
		this.plugin.updateStatus();
		if (this.mode !== 'decks') return;
		this.quiet = true;
		this.show('decks');
	}

	private moveCard(card: Card): void {
		const decks = new Set<string>();
		for (const path of this.deckPaths()) {
			const parts = path.split('/');
			parts.forEach((_, i) => decks.add(parts.slice(0, i + 1).join('/')));
		}
		decks.delete(deckOf(card.file ?? '', this.base));
		new DeckPicker(this.app, [...decks].sort((a, b) => a.localeCompare(b)), (deck) => {
			void this.plugin.store.moveCard(card, deck).then(
				() => this.redrawDeck(),
				(e: unknown) => new Notice(`Revisit: could not move the card (${e instanceof Error ? e.message : String(e)}).`),
			);
		}).open();
	}

	private async deleteFromGrid(card: Card): Promise<void> {
		if (!(await this.askDelete())) return;
		try {
			await this.plugin.store.deleteCard(card);
		} catch (e) {
			new Notice(`Revisit: could not delete the card (${e instanceof Error ? e.message : String(e)}).`);
			return;
		}
		// the card is gone: grades of the last session can no longer be undone safely
		this.undo = [];
		this.redrawDeck();
	}

	// ---- Adding to a deck ----

	private addMenu(ev: MouseEvent, deck: string): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('New card').setIcon('plus').onClick(() => this.newCardIn(deck, deck)));
		menu.addItem((i) => i.setTitle('New subdeck').setIcon('folder-plus').onClick(() => this.askSubdeck(deck)));
		menu.showAtMouseEvent(ev);
	}

	/** A card for `target`; saved, the screen is drawn again where it was asked from. */
	private newCardIn(target: string, origin: string): void {
		this.plugin.openCreate({
			deck: target,
			onSaved: () => {
				if (this.mode !== 'decks' || this.openDeck !== origin) return;
				this.quiet = true;
				this.show('decks');
			},
		});
	}

	/** Only the name is asked: the file is born with the first card saved, so cancelling leaves nothing behind. */
	private askSubdeck(parent: string): void {
		const m = new Modal(this.app);
		m.titleEl.setText(`New subdeck in ${deckName(parent)}`);
		const input = m.contentEl.createEl('input', { type: 'text', cls: 'revisit-name', attr: { 'aria-label': 'Subdeck name' } });
		const confirm = () => {
			const name = subdeckName(input.value);
			if (!name) return input.focus();
			m.close();
			// a name already taken, whatever its case, means that subdeck
			const known = childDecks(this.plugin.store.cards.map((c) => deckOf(c.file ?? '', this.base)), parent);
			const same = known.find((d) => d.name.toLowerCase() === name.toLowerCase());
			this.newCardIn(same?.path ?? `${parent}/${name}`, parent);
		};
		input.onkeydown = (e) => {
			if (e.key !== 'Enter' || e.isComposing) return;
			e.preventDefault();
			confirm();
		};
		m.contentEl.createDiv({ cls: 'modal-button-container' }).createEl('button', { text: 'Continue', cls: 'mod-cta' }).onclick = confirm;
		m.open();
		input.focus();
	}

	async onClose(): Promise<void> {
		window.clearTimeout(this.disarm);
		this.pausedAt = 0;
		this.contentEl.removeClass('is-paused');
		this.dropGrid();
		this.contentEl.empty();
	}
}
