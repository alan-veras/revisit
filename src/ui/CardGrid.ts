import { App, Component, MarkdownRenderer } from 'obsidian';
import { DeckRow } from '../core/decks';
import { faces, QueueItem } from '../core/queue';
import { formatInterval, State } from '../core/scheduler';

/** cards added to the grid at a time, as the panel scrolls */
const BATCH = 60;
/** turning more cards than this at once swaps them without animation */
const ANIMATE_MAX = 12;
/** one half of the turn */
const HALF_MS = 150;
/** clicks on these, on the back of a card, do their own job and leave the card as it is */
const OWN_CLICK = 'a, button, input, summary, audio, video, .callout.is-collapsible .callout-title';

const NAME: Record<number, [string, string]> = { [State.New]: ['New', 'is-new'], [State.Learning]: ['Learning', 'is-learning'], [State.Review]: ['Review', 'is-review'], [State.Relearning]: ['Relearning', 'is-learning'] };

export interface GridCard {
	row: DeckRow;
	item: QueueItem;
}

interface Tile extends GridCard {
	el: HTMLElement;
	flipped: boolean;
	/** owns what the back renders; null while the front shows */
	content: Component | null;
	turning: Animation | null;
}

/**
 * The cards of an opened deck as a grid of flip cards, for looking only: nothing is graded or written.
 * Only one face of a card is in the DOM at a time. Unloading drops everything the backs rendered.
 */
export class CardGrid extends Component {
	readonly el: HTMLElement;
	private tiles: Tile[] = [];
	private sentinel: HTMLElement;
	private observer: IntersectionObserver | null = null;
	private showAll = false;

	/** `scroller` is the element that scrolls; the grid goes at its end. */
	constructor(
		private app: App,
		private scroller: HTMLElement,
		private cards: GridCard[],
		private still: () => boolean,
	) {
		super();
		this.el = scroller.createDiv({ cls: 'revisit-cards' });
		this.sentinel = scroller.createDiv({ cls: 'revisit-cards-more' });
	}

	onload(): void {
		this.addBatch();
		if (this.tiles.length >= this.cards.length) return;
		const observer = (this.observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				this.addBatch();
				// watched anew, so a sentinel still in view asks for the next batch
				observer.unobserve(this.sentinel);
				if (this.tiles.length < this.cards.length) observer.observe(this.sentinel);
			},
			{ root: this.scroller, rootMargin: '400px' },
		));
		observer.observe(this.sentinel);
	}

	onunload(): void {
		this.observer?.disconnect();
		this.observer = null;
		this.tiles.forEach((t) => t.turning?.cancel());
		this.tiles = [];
	}

	get showingAll(): boolean {
		return this.showAll;
	}

	/** Every card to its back, or every card to its front; cards not drawn yet follow when they come. */
	toggleAll(): void {
		this.showAll = !this.showAll;
		const changing = this.tiles.filter((t) => t.flipped !== this.showAll);
		const animate = changing.length <= ANIMATE_MAX;
		changing.forEach((t) => this.turn(t, animate));
	}

	private addBatch(): void {
		const now = new Date();
		for (const card of this.cards.slice(this.tiles.length, this.tiles.length + BATCH)) {
			const tile: Tile = { ...card, el: this.el.createDiv({ cls: 'revisit-card' }), flipped: this.showAll, content: null, turning: null };
			tile.el.onclick = (ev) => this.click(tile, ev);
			this.paint(tile, now);
			this.tiles.push(tile);
		}
	}

	private click(tile: Tile, ev: MouseEvent): void {
		const target = ev.target as HTMLElement;
		const own = target.closest(OWN_CLICK);
		if (own) {
			if (own.matches('a.internal-link')) {
				ev.preventDefault();
				void this.app.workspace.openLinkText(own.getAttribute('data-href') ?? '', tile.item.card.file ?? '', 'split');
			}
			return;
		}
		// text being selected is not a click on the card
		const selection = tile.el.win.getSelection();
		if (selection && !selection.isCollapsed && selection.containsNode(tile.el, true)) return;
		this.turn(tile, true);
	}

	/** Turns one card: half way round, the face is swapped, and it comes round the rest. */
	private turn(tile: Tile, animate: boolean): void {
		tile.flipped = !tile.flipped;
		// a turn still running is dropped; the face drawn is always the latest one asked
		tile.turning?.cancel();
		tile.turning = null;
		if (!animate || this.still()) return this.paint(tile, new Date());
		const edge = (deg: number) => ({ transform: `perspective(800px) rotateY(${deg}deg)` });
		const out = (tile.turning = tile.el.animate([edge(0), edge(90)], { duration: HALF_MS, easing: 'ease-in', fill: 'forwards' }));
		out.onfinish = () => {
			this.paint(tile, new Date());
			out.cancel();
			tile.turning = tile.el.animate([edge(-90), edge(0)], { duration: HALF_MS, easing: 'ease-out' });
		};
	}

	private paint(tile: Tile, now: Date): void {
		if (tile.content) this.removeChild(tile.content);
		tile.content = null;
		const { el, row, item } = tile;
		el.empty();
		el.scrollTop = 0;
		el.toggleClass('is-flipped', tile.flipped);
		if (!tile.flipped) {
			el.createDiv({ text: row.front, cls: 'revisit-card-q revisit-serif' });
			const info = el.createDiv({ cls: 'revisit-card-info' });
			const [name, cls] = NAME[row.state] ?? ['New', 'is-new'];
			info.createSpan({ text: name, cls: `revisit-dot ${cls}` });
			// a new card left out of today's queue (daily cap, or its sibling was asked today) waits for tomorrow
			if (row.state === State.New) {
				if (!row.today) info.createSpan({ text: 'tomorrow' });
				return;
			}
			info.createSpan({ text: row.today ? 'today' : row.due ? `in ${formatInterval(row.due.getTime() - now.getTime())}` : '—', cls: row.today ? 'is-due' : '' });
			info.createSpan({ text: row.memory === null ? '—' : `${Math.round(row.memory * 100)}%` });
			return;
		}
		const content = (tile.content = this.addChild(new Component()));
		const path = item.card.file ?? '';
		el.createDiv({ text: row.front, cls: 'revisit-card-ask' });
		const answer = el.createDiv({ cls: 'revisit-card-a revisit-serif' });
		void MarkdownRenderer.render(this.app, faces(item).back, answer, path, content);
		if (item.card.source) void MarkdownRenderer.render(this.app, item.card.source, el.createDiv({ cls: 'revisit-src' }), path, content);
	}
}
