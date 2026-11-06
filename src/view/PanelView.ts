import { topicsLabel } from '../cards/format';
import { ItemView, Menu, Notice, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { daysLabel, nextInterval, untilLabel } from '../notes/reread';
import { sourceTree, topicTree, TreeNode } from '../srs/tree';
import { forecast } from '../srs/budget';
import { averageAhead, forecastMinutes, planDaysText, sustainability } from '../srs/forecast';
import { toForecastCards } from '../srs/session';
import { drawForecastBars, drawHeatmap } from './charts';
import { cardRow, CardStatus, statusOf, rowOrder } from '../srs/rows';
import { cardStats, folderGroup, retentionBy, reviewsPerDay, topGroups } from '../srs/stats';
import { matchesCard } from './search';
import { ConfirmModal } from '../ui/ConfirmModal';
import { TopicModal } from '../ui/TopicModal';
import type RevisitPlugin from '../main';
import { estimateMinutes, inScope, matchesFilter, NO_SOURCE, QueueItem, scopeOf, sourceName } from '../srs/queue';
import { isNew } from '../srs/scheduler';

export const VIEW_TYPE_PANEL = 'revisit-panel';

const STATUSES: (readonly [CardStatus | 'all', string])[] = [
	['all', 'All states'],
	['new', 'New'],
	['learning', 'Learning'],
	['review', 'Review'],
	['suspended', 'Suspended'],
];
const STATUS_LABEL: Record<CardStatus, string> = { new: 'new', learning: 'learning', review: 'review', suspended: 'suspended' };

/** One screen: what fits today, the browser, the notes and the progress. */
export class PanelView extends ItemView {
	private q = '';
	/** browser filters */
	private status: CardStatus | 'all' = 'all';
	private folderF: string | null = null;
	private limit = 100;
	/** tree rows opened (folder or topic paths) */
	private expanded = new Set<string>();
	private tab: 'today' | 'search' | 'notes' | 'progress' = 'today';
	/** day picked in the next-7-days chart (0 = today); null = the first day with cards */
	private day: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: RevisitPlugin,
	) {
		super(leaf);
	}
	getViewType(): string {
		return VIEW_TYPE_PANEL;
	}
	getDisplayText(): string {
		return 'Revisit';
	}
	getIcon(): string {
		return 'layers';
	}

	async onOpen(): Promise<void> {
		this.draw();
	}

	draw(): void {
		const p = this.plugin;
		const root = this.contentEl;
		root.empty();
		root.addClass('revisit-panel');
		const wrap = root.createDiv({ cls: 'revisit-panel-wrap' });
		const tabs = wrap.createDiv({ cls: 'revisit-tabs' });
		for (const [id, name] of [['today', 'Today'], ['search', 'Search'], ['notes', 'Notes'], ['progress', 'Progress']] as const) {
			const b = tabs.createEl('button', { text: name, cls: this.tab === id ? 'is-on' : '' });
			b.onclick = () => {
				this.tab = id;
				this.draw();
			};
		}
		if (this.tab === 'progress') return this.drawProgress(wrap);
		if (this.tab === 'search') return this.drawSearch(wrap);
		if (this.tab === 'notes') return this.drawNotes(wrap);

		const today = p.session(null);
		const hero = wrap.createDiv({ cls: 'revisit-hero' });
		hero.createDiv({ cls: 'revisit-big', text: String(today.length) });
		hero.createDiv({ cls: 'revisit-muted', text: today.length ? `${today.length === 1 ? 'card fits' : 'cards fit'} today · about ${Math.max(1, estimateMinutes(today, p.secs()))} min` : 'nothing for today' });
		const go = hero.createEl('button', { text: 'Review', cls: 'mod-cta revisit-go' });
		go.disabled = !today.length;
		go.onclick = () => void p.chooseReview(null);
		hero.createEl('button', { text: 'New card' }).onclick = () => void p.captureFor(p.lastSource);
		const q = p.quota();
		hero.createDiv({ cls: 'revisit-muted revisit-small', text: q.quota ? `New today: ${q.used} of ${q.cap}` : 'New cards are paused' });

		this.drawDecks(wrap);
	}

	/** Started once: folders with something for today open on the first draw. */
	private seeded = false;

	/** The cards by folder and note, then by topic when there are topics. */
	private drawDecks(wrap: HTMLElement): void {
		const p = this.plugin;
		const items = p.items().filter((it) => !it.reverse && !it.cloze);
		const active = items.filter((it) => !it.suspended);
		const suspended = items.filter((it) => it.suspended);
		const folders = sourceTree(active);

		// open the folders with something for today, once the cards are loaded
		if (!this.seeded && folders.length) {
			this.seeded = true;
			for (const t of folders) if (p.session(t.scope).length) this.expanded.add(t.path);
		}

		this.drawTree(wrap.createDiv({ cls: 'revisit-list' }), folders, sourceTree(suspended), items);
		const topics = topicTree(active);
		if (topics.length) {
			wrap.createEl('h4', { text: 'By topic', cls: 'revisit-sub' });
			this.drawTree(wrap.createDiv({ cls: 'revisit-list' }), topics, topicTree(suspended), items);
		}
		if (p.quota().reduced) wrap.createDiv({ cls: 'revisit-deck-empty', text: 'Due reviews take up the minute budget: the new-card quota shrank today.' });
	}

	/** One tree as clean rows: pills for what is due (blue) and new (green); an open parent shows only its name. */
	private drawTree(list: HTMLElement, tree: TreeNode[], suspended: TreeNode[], items: QueueItem[]): void {
		const p = this.plugin;
		const suspendedOf = (path: string) => {
			const find = (ns: TreeNode[]): number => {
				for (const n of ns) {
					if (n.path === path) return n.cards;
					const r = find(n.children);
					if (r) return r;
				}
				return 0;
			};
			return find(suspended);
		};
		const row = (node: TreeNode, depth: number) => {
			const s = p.session(node.scope, undefined, false, node.topic);
			const newCount = s.filter((it) => isNew(it.fsrs)).length;
			const toReview = s.length - newCount;
			const kids = node.children.length > 0;
			const open = this.expanded.has(node.path);
			const r = list.createDiv({ cls: `revisit-li is-d${Math.min(depth, 3)}` + (s.length ? '' : ' is-quiet') });
			r.style.paddingLeft = `${6 + depth * 20}px`;
			const caret = r.createSpan({ cls: 'revisit-caret' + (open ? ' is-open' : '') });
			if (kids) setIcon(caret, 'chevron-right');
			r.createSpan({ cls: 'revisit-li-title', text: node.name });
			const susp = suspendedOf(node.path);

			// rollup: an open parent is only a title; the numbers live on the deepest visible row
			const summary = !(kids && open);
			const pills = r.createSpan({ cls: 'revisit-li-pills' });
			if (summary && toReview) setTooltip(pills.createSpan({ cls: 'revisit-np is-due', text: String(toReview) }), `${toReview} to review today`);
			if (summary && newCount) setTooltip(pills.createSpan({ cls: 'revisit-np is-new', text: String(newCount) }), `${newCount} ${newCount === 1 ? 'new enters' : 'new enter'} today`);

			// nothing for today: say when the next review falls, so the row is never mute
			if (summary && !s.length) {
				const next = items
					.filter((it) => !it.suspended && it.fsrs && !isNew(it.fsrs) && matchesFilter(it, node.scope, node.topic))
					.reduce<Date | null>((m, it) => (it.fsrs && (!m || it.fsrs.due < m) ? it.fsrs.due : m), null);
				if (next) setTooltip(r.createSpan({ cls: 'revisit-li-next', text: untilLabel(next, new Date()) }), `Next review: ${next.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}`);
			}
			const total = r.createSpan({ cls: 'revisit-li-total', text: summary ? String(node.cards) : '' });
			if (summary) setTooltip(total, `${node.cards} ${node.cards === 1 ? 'active card' : 'active cards'}${susp ? ` · ${susp} suspended` : ''}`);

			const go = r.createSpan({ cls: 'revisit-li-go' });
			if (s.length) {
				setIcon(go, 'play');
				setTooltip(go, `Review ${node.name} (${s.length})`);
				go.onclick = (e) => {
					e.stopPropagation();
					void p.chooseReview(node.scope, node.topic);
				};
			}
			if (node.topic) {
				const acts = r.createSpan({ cls: 'revisit-li-go' });
				setIcon(acts, 'more-horizontal');
				setTooltip(acts, `Manage the topic ${node.name}`);
				acts.onclick = (e) => {
					e.stopPropagation();
					this.topicMenu(e, node);
				};
			} else if (!kids && node.scope && node.scope !== NO_SOURCE) {
				const acts = r.createSpan({ cls: 'revisit-li-go' });
				setIcon(acts, 'plus');
				setTooltip(acts, 'New card from this note');
				acts.onclick = (e) => {
					e.stopPropagation();
					const f = p.app.vault.getAbstractFileByPath(node.scope as string);
					if (f instanceof TFile) void p.captureFor(f);
				};
			}
			if (kids)
				r.onclick = () => {
					if (open) this.expanded.delete(node.path);
					else this.expanded.add(node.path);
					this.draw();
				};
			else if (s.length) r.onclick = () => void p.chooseReview(node.scope, node.topic);
			if (open) for (const c of node.children) row(c, depth + 1);
		};
		for (const t of tree) row(t, 0);
	}

	/** Whole notes to reread: today's, the one being read, and the next ones. */
	private drawNotes(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const due = p.dueRereads(now);
		const all = p.rereadNotes();
		const name = (path: string) => path.split('/').pop()?.replace(/\.md$/, '') ?? path;
		const open = (path: string) => void p.openReread(path);

		const hero = wrap.createDiv({ cls: 'revisit-hero' });
		hero.createDiv({ cls: 'revisit-big', text: String(due.length) });
		hero.createDiv({ cls: 'revisit-muted', text: due.length ? `${due.length === 1 ? 'note to reread' : 'notes to reread'} today` : 'no note to reread today' });
		const go = hero.createEl('button', { text: 'Read next', cls: 'mod-cta revisit-go' });
		go.disabled = !due.length;
		go.onclick = () => void p.openNextReread();

		if (p.reading) {
			const path = p.reading;
			const box = wrap.createDiv({ cls: 'revisit-reading' });
			box.createDiv({ cls: 'revisit-muted', text: 'Reading now' });
			box.createEl('h3', { text: name(path) });
			box.createDiv({ cls: 'revisit-muted', text: 'Done? Rate the reread:' });
			const prev = all.find((n) => n.path === path)?.r;
			const row = box.createDiv({ cls: 'revisit-reading-btns' });
			for (const [l, name] of [['hard', 'Hard'], ['good', 'Good'], ['easy', 'Easy']] as const) {
				const b = row.createEl('button', { cls: l === 'good' ? 'mod-cta' : '' });
				b.createEl('b', { text: name });
				b.createEl('small', { text: daysLabel(nextInterval(prev, l)) });
				b.onclick = () => void p.gradeReread(path, l);
			}
			const skip = box.createEl('button', { text: 'Not now', cls: 'revisit-link' });
			skip.onclick = () => {
				p.reading = null;
				this.draw();
			};
		}

		if (due.length) {
			wrap.createEl('h4', { text: 'For today', cls: 'revisit-sub' });
			const list = wrap.createDiv({ cls: 'revisit-reread-list' });
			for (const path of due) {
				const r = all.find((n) => n.path === path)?.r;
				const row = list.createDiv({ cls: 'revisit-reread-row', attr: { role: 'button', tabindex: '0' } });
				row.createSpan({ text: name(path) });
				row.createSpan({ cls: 'revisit-reread-meta', text: r ? `read ${r.times}x` : 'new' });
				setIcon(row.createSpan({ cls: 'revisit-reread-go' }), 'chevron-right');
				row.onclick = () => open(path);
				row.onkeydown = (e) => e.key === 'Enter' && open(path);
			}
		}

		const later = all
			.filter((n) => n.r && new Date(n.r.due) > now)
			.sort((a, b) => (a.r?.due ?? '').localeCompare(b.r?.due ?? ''))
			.slice(0, 8);
		if (later.length) {
			wrap.createEl('h4', { text: 'Upcoming', cls: 'revisit-sub' });
			const list = wrap.createDiv({ cls: 'revisit-reread-list' });
			for (const n of later) {
				const row = list.createDiv({ cls: 'revisit-reread-row', attr: { role: 'button', tabindex: '0' } });
				row.createSpan({ text: name(n.path) });
				row.createSpan({ cls: 'revisit-reread-meta', text: new Date(n.r?.due ?? '').toLocaleDateString('en-US', { day: '2-digit', month: 'short' }) });
				row.onclick = () => open(n.path);
				row.onkeydown = (e) => e.key === 'Enter' && open(n.path);
			}
		}

		wrap.createEl('p', {
			cls: 'revisit-muted revisit-small',
			text: `${all.length} ${all.length === 1 ? 'note' : 'notes'} rereading. To add one, right-click it and choose "Reread this note from time to time"${p.settings.rereadTag ? `, or use the ${p.settings.rereadTag} tag` : ''}.`,
		});
	}

	/** The browser: search, filters by state and folder, and one dense row per card, like the Anki desktop table. */
	private drawSearch(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const stats = cardStats(p.store.log);

		const bar = wrap.createDiv({ cls: 'revisit-filters' });
		const input = bar.createEl('input', { type: 'search', attr: { placeholder: 'Search cards' } });
		input.value = this.q;
		input.oninput = () => {
			this.q = input.value;
			this.draw();
		};
		const est = bar.createEl('select', { attr: { 'aria-label': 'State' } });
		for (const [v, name] of STATUSES) {
			const o = est.createEl('option', { text: name, value: v });
			if (this.status === v) o.selected = true;
		}
		est.onchange = () => {
			this.status = est.value as CardStatus | 'all';
			this.draw();
		};
		const sel = bar.createEl('select', { attr: { 'aria-label': 'Folder' } });
		const folders = [...new Set(p.items().map((it) => scopeOf(it).split('/')[0] as string))].sort((x, y) => x.localeCompare(y));
		for (const a of ['All folders', ...folders]) {
			const o = sel.createEl('option', { text: a, value: a });
			if ((this.folderF ?? 'All folders') === a) o.selected = true;
		}
		sel.onchange = () => {
			this.folderF = sel.value === 'All folders' ? null : sel.value;
			this.draw();
		};
		bar.createEl('button', { text: 'New card' }).onclick = () => void p.captureFor(p.lastSource);

		const clean = this.q.trim() || this.status !== 'all' || this.folderF;
		if (!clean) {
			wrap.createDiv({ cls: 'revisit-muted revisit-empty', text: 'Type to search, or filter by state and folder.' });
			return;
		}
		const rows = p
			.items()
			.map((it) => cardRow(it, stats, now))
			.filter((r) => (this.status === 'all' || r.status === this.status) && (!this.folderF || inScope(scopeOf(r.item), this.folderF)))
			.filter((r) => matchesCard(r.item.card, this.q))
			.sort(rowOrder);
		const dueNow = rows.filter((r) => r.dueToday).length;
		const countLine = wrap.createDiv({ cls: 'revisit-muted revisit-small revisit-count' });
		countLine.createSpan({ text: `${rows.length} ${rows.length === 1 ? 'card' : 'cards'}${dueNow ? ` · ${dueNow} due today` : ''}` });
		const unique = [...new Map(rows.map((r) => [r.id, r.item.card])).values()];
		const bulkCards = unique.filter((c) => !c.inline);
		const skippedInline = unique.length - bulkCards.length;
		if (bulkCards.length) {
			const bulk = countLine.createEl('button', { text: `Change topic of ${bulkCards.length}…`, cls: 'revisit-link' });
			setTooltip(bulk, 'Sets one topic on every card matching the search and the filters');
			bulk.onclick = () => {
				const n = bulkCards.length;
				const skipNote = skippedInline ? ` ${skippedInline} card${skippedInline === 1 ? '' : 's'} written inside notes keep their place (change it there).` : '';
				new TopicModal(p.app, '', p.topics(), `Topic of ${n} ${n === 1 ? 'card' : 'cards'}`, 'Topic > subtopic; empty removes the topic', (topics) =>
					new ConfirmModal(p.app, 'Change topic', `Sets "${topics.join('; ') || 'no topic'}" as the only topic of ${n} ${n === 1 ? 'card' : 'cards'}.${skipNote}`, 'Change', () =>
						void p.setCardsTopics(bulkCards, topics).then(() => this.draw()),
					),
				);
			};
		}
		if (!rows.length) {
			wrap.createDiv({ cls: 'revisit-muted revisit-empty', text: 'No cards with these filters.' });
			return;
		}

		const head = wrap.createDiv({ cls: 'revisit-thead' });
		head.createSpan({ cls: 'revisit-th-c', text: 'Card' });
		head.createSpan({ cls: 'revisit-th', text: 'State' });
		head.createSpan({ cls: 'revisit-th', text: 'Due' });
		head.createSpan({ cls: 'revisit-th is-n', text: '✓' });
		head.createSpan({ cls: 'revisit-th is-n', text: '✗' });

		const table = wrap.createDiv({ cls: 'revisit-table' });
		for (const r of rows.slice(0, this.limit)) {
			const row = table.createDiv({ cls: `revisit-tr is-${r.status}` });
			const c = row.createDiv({ cls: 'revisit-td-c' });
			c.createDiv({ cls: 'revisit-td-f', text: r.front.replace(/\s+/g, ' ') });
			c.createDiv({ cls: 'revisit-td-sub', text: [sourceName(r.item), topicsLabel(r.topics), r.side !== 'front' ? r.side : r.type].filter(Boolean).join(' · ') });
			row.createSpan({ cls: `revisit-st is-${r.status}`, text: STATUS_LABEL[r.status] });
			row.createSpan({ cls: 'revisit-td-due', text: r.due ? untilLabel(r.due, now) : '—' });
			row.createSpan({ cls: 'revisit-td-n is-ok', text: r.ok ? String(r.ok) : '' });
			row.createSpan({ cls: 'revisit-td-n is-bad', text: r.bad ? String(r.bad) : '' });
			const acts = row.createDiv({ cls: 'revisit-td-acts' });
			acts.createEl('button', { text: 'Edit' }).onclick = (e) => {
				e.stopPropagation();
				p.editCard(r.item.card, () => this.draw());
			};
			const more = acts.createEl('button', { text: '⋯', attr: { 'aria-label': 'More actions' } });
			more.onclick = (e) => {
				e.stopPropagation();
				this.cardMenu(e, r);
			};
		}
		if (rows.length > this.limit) {
			const more = wrap.createEl('button', { text: `Show more ${rows.length - this.limit}`, cls: 'revisit-link revisit-more' });
			more.onclick = () => {
				this.limit += 200;
				this.draw();
			};
		}
	}

	private cardMenu(e: MouseEvent, r: ReturnType<typeof cardRow>): void {
		const p = this.plugin;
		const menu = new Menu();
		menu.addItem((i) =>
			i.setTitle('Review the cards of this note').setIcon('layers').onClick(() => {
				const src = p.resolveSource(r.item.card);
				const f = src ? p.app.vault.getAbstractFileByPath(src) : null;
				if (f instanceof TFile) void p.reviewNote(f);
				else new Notice('Revisit: the source of this card is not in the vault.');
			}),
		);
		menu.addItem((i) =>
			i
				.setTitle('Change topic…')
				.setIcon('tag')
				.onClick(() => {
					new TopicModal(p.app, r.item.card.topics.join('; '), p.topics(), 'Topic of the card', 'Topic > subtopic; empty removes the topic', (topics) =>
						void p.setCardsTopics([r.item.card], topics).then(() => this.draw()),
					);
				}),
		);
		menu.addItem((i) => i.setTitle('Reset: comes back as new').setIcon('rotate-ccw').onClick(() => void p.resetCard(r.item.card)));
		menu.addItem((i) =>
			i
				.setTitle(r.status === 'suspended' ? 'Unsuspend' : 'Suspend')
				.setIcon(r.status === 'suspended' ? 'play' : 'pause')
				.onClick(async () => {
					p.store.state[r.id] = { ...(p.store.state[r.id] ?? {}), st: r.status === 'suspended' ? 'active' : 'suspended' };
					await p.store.saveState();
					p.updateStatus();
					this.draw();
				}),
		);
		menu.addItem((i) =>
			i
				.setTitle('Delete card')
				.setIcon('trash-2')
				.onClick(() => {
					if (r.item.card.inline) return void new Notice('Revisit: this card is written in the note; delete it there.');
					new ConfirmModal(p.app, 'Delete card', r.front.replace(/\s+/g, ' ').slice(0, 140), 'Delete', () => void p.deleteCard(r.item.card).then(() => this.draw()));
				}),
		);
		menu.showAtMouseEvent(e);
	}

	/** Manage one topic row: new card in it, rename, retire or wake it up. */
	private topicMenu(e: MouseEvent, node: TreeNode): void {
		const p = this.plugin;
		const topic = node.topic as string;
		const menu = new Menu();
		menu.addItem((i) => i.setTitle('New card in this topic').setIcon('plus').onClick(() => void p.captureFor(p.lastSource, topic)));
		menu.addItem((i) =>
			i
				.setTitle('Rename topic…')
				.setIcon('pencil')
				.onClick(() => {
					new TopicModal(p.app, topic, p.topics(), `Rename ${topic}`, 'New name; empty removes the topic', (topics) => {
						const to = topics.join('; ');
						if (!to) new ConfirmModal(p.app, 'Remove the topic', `"${topic}" comes off every card carrying it. The cards stay.`, 'Remove', () => void p.renameTopic(topic, ''));
						else void p.renameTopic(topic, to);
					});
				}),
		);
		const under = p.items().filter((it) => matchesFilter(it, null, topic));
		const suspended = under.filter((it) => it.suspended).length;
		const activeCount = under.length - suspended;
		if (activeCount)
			menu.addItem((i) =>
				i
					.setTitle(`Retire topic (suspends ${activeCount})`)
					.setIcon('pause')
					.onClick(() =>
						new ConfirmModal(p.app, 'Retire topic', `Suspends the ${activeCount} active cards under "${topic}". They leave every session until you wake the topic up.`, 'Retire', () =>
							void p.setTopicSuspended(topic, true),
						),
					),
			);
		if (suspended)
			menu.addItem((i) => i.setTitle(`Wake topic up (activates ${suspended})`).setIcon('play').onClick(() => void p.setTopicSuspended(topic, false)));
		menu.showAtMouseEvent(e);
	}

	/** Workload ahead: tomorrow, the week, the peak, 30 days of bars against the budget, and the 90-day heatmap. */
	private drawLoad(wrap: HTMLElement, now: Date): void {
		const p = this.plugin;
		const items = p.items();
		const cards = toForecastCards(items);
		const budget = p.settings.budgetMinutes;
		const f = forecastMinutes(cards, p.secs(), now, 30);
		const EXTRA_NEW = 5;
		const sus = sustainability(cards, p.secs(), { newPerDay: p.settings.newPerDay, extraNew: EXTRA_NEW, budgetMinutes: budget });

		const section = wrap.createDiv({ cls: 'revisit-load' });
		const head = section.createDiv({ cls: 'revisit-load-head' });
		const title = head.createDiv();
		title.createEl('h3', { text: 'Workload' });
		title.createDiv({ cls: 'revisit-muted', text: 'Forecast for the next 30 days' });
		const badge = head.createSpan({ cls: `revisit-badge is-${sus.label.toLowerCase()}` });
		setIcon(badge.createSpan(), sus.label === 'Heavy' ? 'alert-triangle' : 'check');
		badge.createSpan({ text: sus.label });
		setTooltip(badge, `About ${Math.round(sus.currentMinutes)} min a day in the long run at ${p.settings.newPerDay} new cards a day, against a budget of ${budget} min`);

		const stats = section.createDiv({ cls: 'revisit-load-stats' });
		const stat = (v: number, label: string) => {
			const d = stats.createDiv();
			const big = d.createDiv({ cls: 'revisit-stat-v', text: String(Math.round(v)) });
			big.createSpan({ cls: 'revisit-stat-u', text: ' min' });
			d.createDiv({ cls: 'revisit-muted', text: label });
		};
		stat(f.tomorrow, 'tomorrow');
		stat(averageAhead(f), '7-day average');
		stat(f.peak.minutes, 'peak');

		const day = (i: number) => (i === 0 ? 'Today' : new Date(now.getTime() + i * 86400000).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' }));
		drawForecastBars(section, f.perDay, budget, day);
		const legend = section.createDiv({ cls: 'revisit-legend' });
		legend.createSpan({ cls: 'revisit-legend-key', text: 'Minutes per day' });
		legend.createSpan({ text: `Light under ${Math.round(budget * 0.6)} · Sustainable ${Math.round(budget * 0.6)}-${budget} · Heavy over ${budget} min a day` });
		const cu = p.catchUp(now, items);
		if (cu) {
			const line = section.createDiv({ cls: 'revisit-catchup revisit-catchup-panel' });
			line.createDiv({
				cls: 'revisit-catchup-text',
				text: `Catch-up plan: ${cu.offer.overdue} overdue ${cu.offer.overdue === 1 ? 'card' : 'cards'} (about ${Math.round(cu.offer.overdueMinutes)} min) spread over ${planDaysText(cu.offer)}, about ${Math.max(1, Math.round(cu.offer.todayMinutes))} min today.`,
			});
			line.createEl('button', { text: "Start today's catch-up", cls: 'revisit-catchup-go' }).onclick = () => void p.startCatchUp();
		}
		section.createDiv({
			cls: 'revisit-muted revisit-load-note',
			text: `With ${EXTRA_NEW} more new cards a day: about ${Math.round(sus.whatIfMinutes)} min a day in the long run, ${sus.whatIfLabel === 'Heavy' ? 'over your budget' : sus.whatIfLabel === 'Light' ? 'still light' : 'still sustainable'}.`,
		});

		section.createEl('h4', { text: 'Reviews, 90 days', cls: 'revisit-sub' });
		const counts = reviewsPerDay(p.store.log, now, 90);
		const grid = section.createDiv({ cls: 'revisit-heat' });
		drawHeatmap(grid, counts, now, (d, n) => `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}: ${n ? `${n} ${n === 1 ? 'review' : 'reviews'}` : 'no reviews'}`);
		const key = section.createDiv({ cls: 'revisit-legend revisit-heat-key' });
		key.createSpan({ text: 'Less' });
		for (let l = 0; l <= 4; l++) key.createSpan({ cls: `revisit-swatch is-l${l}` });
		key.createSpan({ text: 'More' });
	}

	private drawProgress(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const items = p.items();
		const log = p.store.log;
		const meta = Math.round(p.settings.retention * 100);
		const byKey = new Map(items.map((i) => [i.key, i]));
		const ret = retentionBy(log, (id) => {
			const it = byKey.get(id);
			return it ? folderGroup(scopeOf(it)) : null;
		});
		const all = [...ret.values()].reduce((a, r) => ({ ok: a.ok + r.ok, total: a.total + r.total }), { ok: 0, total: 0 });
		const past = reviewsPerDay(log, now, 30);

		this.drawLoad(wrap, now);

		const kpis = wrap.createDiv({ cls: 'revisit-kpis' });
		const kpi = (v: string, label: string, small?: string) => {
			const k = kpis.createDiv({ cls: 'revisit-kpi' });
			const n = k.createDiv({ cls: 'revisit-kpi-v', text: v });
			if (small) n.createSpan({ cls: 'revisit-muted revisit-kpi-s', text: small });
			k.createDiv({ cls: 'revisit-muted revisit-small', text: label });
		};
		kpi(all.total ? `${Math.round((all.ok / all.total) * 100)}%` : '—', `mature accuracy · target ${meta}%`);
		kpi(String(past.filter((x) => x > 0).length), 'days with a session', ' / 30');
		kpi(String(p.store.cards.length), 'cards in total');

		const by = { new: 0, learning: 0, review: 0, suspended: 0 };
		for (const it of items) by[statusOf(it)]++;
		const strip = wrap.createDiv({ cls: 'revisit-statuses' });
		for (const e of ['new', 'learning', 'review', 'suspended'] as const) {
			const n = by[e];
			const pill = strip.createSpan({ cls: `revisit-st is-${e}${n ? '' : ' is-zero'}`, text: `${STATUS_LABEL[e]} ${n}` });
			setTooltip(pill, `${n} ${n === 1 ? 'card' : 'cards'} ${STATUS_LABEL[e]}`);
		}

		const chart = (title: string, sub: string) => {
			const c = wrap.createDiv({ cls: 'revisit-chart' });
			c.createEl('h4', { text: title });
			c.createDiv({ cls: 'revisit-muted revisit-small', text: sub });
			return c;
		};
		const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
		const budget = p.settings.budgetMinutes;
		const fut = forecast(items, p.secs(), now).map((m) => Math.ceil(m));
		const lab7 = fut.map((_, i) => (i === 0 ? 'today' : i === 1 ? 'tomorrow' : (DAYS[(now.getDay() + i) % 7] as string)));
		// cards due on each of the next 7 days (overdue count today)
		const start = new Date(now);
		start.setHours(0, 0, 0, 0);
		const byDay: QueueItem[][] = fut.map(() => []);
		for (const it of items) {
			if (it.suspended || !it.fsrs || isNew(it.fsrs)) continue;
			const d = Math.max(0, Math.floor((it.fsrs.due.getTime() - start.getTime()) / 86400000));
			if (d < 7) byDay[d]?.push(it);
		}
		const pick = this.day ?? Math.max(0, byDay.findIndex((l) => l.length));
		const next = chart('Next 7 days', 'Estimated minutes per day; click a day to see the cards');
		cols(
			next,
			fut,
			lab7,
			fut.map((v, i) => `${lab7[i] ?? ''} · ${byDay[i]?.length ?? 0} cards · ~${v} min${v > budget ? ' · over budget' : ''}`),
			budget,
			pick,
			(i) => {
				this.day = i;
				this.draw();
			},
		);
		const list = next.createDiv({ cls: 'revisit-daylist' });
		const cards = byDay[pick] ?? [];
		list.createDiv({ cls: 'revisit-daylist-h', text: `${lab7[pick] ?? ''}: ${cards.length ? `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}` : 'no cards'}` });
		for (const it of cards) {
			const row = list.createDiv({ cls: 'revisit-result' });
			const t = row.createDiv({ cls: 'revisit-result-t' });
			t.createDiv({ cls: 'revisit-result-f', text: it.card.front.replace(/\s+/g, ' ') });
			t.createDiv({ cls: 'revisit-muted revisit-small', text: [sourceName(it), topicsLabel(it.card.topics), it.card.type].filter(Boolean).join(' · ') });
			row.createEl('button', { text: 'Edit' }).onclick = () => p.editCard(it.card, () => this.draw());
		}
		const bars = (title: string, groups: [string, { ok: number; total: number }][]) => {
			const hb = chart(title, `Cards seen 7 or more days ago; the line is the target of ${meta}%`).createDiv({ cls: 'revisit-hbars' });
			for (const [name, r] of groups) {
				const pct = Math.round((r.ok / r.total) * 100);
				const row = hb.createDiv({ cls: 'revisit-hb' });
				setTooltip(row, `${name} · ${pct}% over ${r.total} reviews`);
				row.createSpan({ cls: 'revisit-hb-name', text: name });
				const track = row.createSpan({ cls: 'revisit-hb-track' });
				track.createEl('i').style.width = `${pct}%`;
				track.createEl('b').style.left = `${meta}%`;
				row.createSpan({ cls: 'revisit-hb-val', text: `${pct}%` });
			}
		};
		if (ret.size) bars('Retention by folder', topGroups(ret));
		const retTopic = retentionBy(log, (id) => byKey.get(id)?.card.topics[0]?.split(' > ')[0] ?? null);
		if (retTopic.size) bars('Retention by topic', topGroups(retTopic));
	}
}

/** Single-series columns, one hue, optional limit line; the value shows on hover. */
function cols(parent: HTMLElement, values: number[], labels: string[], tips: string[], limit?: number, picked?: number, onPick?: (i: number) => void): void {
	const max = Math.max(1, limit ?? 0, ...values) * 1.1;
	const box = parent.createDiv({ cls: 'revisit-cols' });
	if (limit) {
		const line = box.createDiv({ cls: 'revisit-limit' });
		line.style.bottom = `${(limit / max) * 100}%`;
		line.createSpan({ text: `budget ${limit} min` });
	}
	values.forEach((v, i) => {
		const col = box.createDiv({ cls: 'revisit-col' + (onPick ? ' is-click' : '') + (picked === i ? ' is-picked' : '') });
		if (onPick) col.onclick = () => onPick(i);
		setTooltip(col, tips[i] ?? '');
		col.createEl('i').style.height = `${(v / max) * 100}%`;
	});
	const xl = parent.createDiv({ cls: 'revisit-xl' });
	labels.forEach((l, i) => xl.createSpan({ text: l, cls: picked === i ? 'is-picked' : '' }));
}
