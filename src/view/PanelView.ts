import { topicsLabel } from '../cards/format';
import { ItemView, Menu, Notice, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { daysLabel, nextInterval, untilLabel } from '../notes/reread';
import { topicTree, TreeNode } from '../srs/tree';
import { forecast } from '../srs/budget';
import { cardRow, CardStatus, statusOf, rowOrder } from '../srs/rows';
import { cardStats, retentionBy, reviewsPerDay } from '../srs/stats';
import { matchesCard } from './search';
import { AREAS } from '../cards/types';
import type RevisitPlugin from '../main';
import { estimateMinutes, matchesFilter, NO_AREA, QueueItem } from '../srs/queue';
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
	private areaF: string | null = null;
	private limit = 100;
	/** tree rows opened (area or area > topic paths) */
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
		go.onclick = () => void p.review(null);

		this.drawDecks(wrap);
	}

	/** Started once: areas with something for today open on the first draw. */
	private seeded = false;

	/** The decks as a clean tree: pills for what is due (blue) and new (green), the area's quota as a small meter; an open parent shows only its name. */
	private drawDecks(wrap: HTMLElement): void {
		const p = this.plugin;
		const q = p.quota();
		const items = p.items().filter((it) => !it.reverse && !it.cloze);
		const tree = topicTree(items.filter((it) => !it.suspended));
		const suspended = topicTree(items.filter((it) => it.suspended));
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

		// open the areas with something for today, once the cards are loaded
		if (!this.seeded && tree.length) {
			this.seeded = true;
			for (const t of tree) if (p.session(t.area).length) this.expanded.add(t.path);
		}

		const list = wrap.createDiv({ cls: 'revisit-list' });
		const row = (node: TreeNode, depth: number) => {
			const s = p.session(node.area, undefined, false, node.topic);
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
					.filter((it) => !it.suspended && it.fsrs && !isNew(it.fsrs) && matchesFilter(it, node.area === NO_AREA ? null : node.area, node.topic))
					.reduce<Date | null>((m, it) => (it.fsrs && (!m || it.fsrs.due < m) ? it.fsrs.due : m), null);
				if (next) setTooltip(r.createSpan({ cls: 'revisit-li-next', text: untilLabel(next, new Date()) }), `Next review: ${next.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}`);
			}
			const total = r.createSpan({ cls: 'revisit-li-total', text: summary ? String(node.cards) : '' });
			if (summary) setTooltip(total, `${node.cards} ${node.cards === 1 ? 'active card' : 'active cards'}${susp ? ` · ${susp} suspended` : ''}`);

			const quota = depth === 0 ? q.areas.find((a) => a.area === node.area) : undefined;
			const meter = r.createSpan({ cls: 'revisit-li-quota' });
			if (quota) {
				const full = quota.cap > 0 && quota.free === 0;
				const paused = quota.quota === 0;
				if (full) meter.addClass('is-full');
				const bar = meter.createSpan({ cls: 'revisit-li-bar' });
				bar.createEl('i').style.width = `${quota.cap ? Math.min(100, (quota.used / quota.cap) * 100) : 0}%`;
				meter.createSpan({ cls: 'revisit-li-quota-n', text: paused ? 'paused' : `${quota.used}/${quota.cap}` });
				if (full) setIcon(meter.createSpan({ cls: 'revisit-li-ok' }), 'check');
				setTooltip(meter, paused ? 'Quota 0: new cards of this area are paused' : full ? `New quota filled for today (${quota.cap}): back tomorrow` : `New today: ${quota.used} of ${quota.cap}${q.reduced ? ' · quota shrunk by the budget' : ''}`);
			}

			const go = r.createSpan({ cls: 'revisit-li-go' });
			if (s.length) {
				setIcon(go, 'play');
				setTooltip(go, `Review ${node.topic ?? node.area} (${s.length})`);
				go.onclick = (e) => {
					e.stopPropagation();
					void p.review(node.area, undefined, false, node.topic);
				};
			}
			if (kids)
				r.onclick = () => {
					if (open) this.expanded.delete(node.path);
					else this.expanded.add(node.path);
					this.draw();
				};
			else if (s.length) r.onclick = () => void p.review(node.area, undefined, false, node.topic);
			if (open) for (const c of node.children) row(c, depth + 1);
		};
		for (const t of tree) row(t, 0);

		if (q.reduced) list.createDiv({ cls: 'revisit-deck-empty', text: 'Due reviews take up the minute budget: the new-card quotas shrank today.' });
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
			const list = wrap.createDiv({ cls: 'revisit-areas' });
			for (const path of due) {
				const r = all.find((n) => n.path === path)?.r;
				const row = list.createDiv({ cls: 'revisit-area' });
				row.createSpan({ text: name(path) });
				row.createSpan({ cls: 'revisit-area-n', text: r ? `read ${r.times}x` : 'new' });
				setIcon(row.createSpan({ cls: 'revisit-area-go' }), 'chevron-right');
				row.onclick = () => open(path);
			}
		}

		const later = all
			.filter((n) => n.r && new Date(n.r.due) > now)
			.sort((a, b) => (a.r?.due ?? '').localeCompare(b.r?.due ?? ''))
			.slice(0, 8);
		if (later.length) {
			wrap.createEl('h4', { text: 'Upcoming', cls: 'revisit-sub' });
			const list = wrap.createDiv({ cls: 'revisit-areas' });
			for (const n of later) {
				const row = list.createDiv({ cls: 'revisit-area' });
				row.createSpan({ text: name(n.path) });
				row.createSpan({ cls: 'revisit-area-n', text: new Date(n.r?.due ?? '').toLocaleDateString('en-US', { day: '2-digit', month: 'short' }) });
				row.onclick = () => open(n.path);
			}
		}

		wrap.createEl('p', {
			cls: 'revisit-muted revisit-small',
			text: `${all.length} ${all.length === 1 ? 'note' : 'notes'} rereading. To add one, right-click it and choose "Reread this note from time to time"${p.settings.rereadTag ? `, or use the ${p.settings.rereadTag} tag` : ''}.`,
		});
	}

	/** The browser: search, filters by state and area, and one dense row per card, like the Anki desktop table. */
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
		const sel = bar.createEl('select', { attr: { 'aria-label': 'Area' } });
		for (const a of ['All areas', ...AREAS, NO_AREA] as const) {
			const o = sel.createEl('option', { text: a, value: a });
			if ((this.areaF ?? 'All areas') === a) o.selected = true;
		}
		sel.onchange = () => {
			this.areaF = sel.value === 'All areas' ? null : sel.value;
			this.draw();
		};

		const clean = this.q.trim() || this.status !== 'all' || this.areaF;
		if (!clean) {
			wrap.createDiv({ cls: 'revisit-muted revisit-empty', text: 'Type to search, or filter by state and area.' });
			return;
		}
		const rows = p
			.items()
			.map((it) => cardRow(it, stats, now))
			.filter((r) => (this.status === 'all' || r.status === this.status) && (!this.areaF || (r.area ?? NO_AREA) === this.areaF))
			.filter((r) => matchesCard(r.item.card, this.q))
			.sort(rowOrder);
		const dueNow = rows.filter((r) => r.dueToday).length;
		wrap.createDiv({
			cls: 'revisit-muted revisit-small revisit-count',
			text: `${rows.length} ${rows.length === 1 ? 'card' : 'cards'}${dueNow ? ` · ${dueNow} due today` : ''}`,
		});
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
			c.createDiv({ cls: 'revisit-td-sub', text: [r.area ?? NO_AREA, topicsLabel(r.topics), r.side !== 'front' ? r.side : r.type].filter(Boolean).join(' · ') });
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
		menu.showAtMouseEvent(e);
	}

	private drawProgress(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const items = p.items();
		const log = p.store.log;
		const meta = Math.round(p.settings.retention * 100);
		const areaOf = new Map(items.map((i) => [i.key, i.area]));
		const ret = retentionBy(log, (id) => areaOf.get(id) ?? null);
		const all = [...ret.values()].reduce((a, r) => ({ ok: a.ok + r.ok, total: a.total + r.total }), { ok: 0, total: 0 });
		const past = reviewsPerDay(log, now, 30);

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
			t.createDiv({ cls: 'revisit-muted revisit-small', text: [it.area ?? NO_AREA, topicsLabel(it.card.topics), it.card.type].filter(Boolean).join(' · ') });
			row.createEl('button', { text: 'Edit' }).onclick = () => p.editCard(it.card, () => this.draw());
		}
		const day = (i: number) => new Date(now.getTime() - (29 - i) * 86400000);
		cols(
			chart('Last 30 days', `${past.reduce((a, b) => a + b, 0)} reviews; days without a bar had no session`),
			past,
			past.map((_, i) => (i % 7 === 1 || i === 29 ? String(day(i).getDate()) : '')),
			past.map((v, i) => `${day(i).getDate()}/${day(i).getMonth() + 1} · ${v ? `${v} reviews` : 'no session'}`),
		);

		const hb = chart('Accuracy by area', `Cards seen 7 or more days ago; the line is the target of ${meta}%`).createDiv({ cls: 'revisit-hbars' });
		for (const a of AREAS) {
			const r = ret.get(a);
			const pct = r ? Math.round((r.ok / r.total) * 100) : null;
			const row = hb.createDiv({ cls: 'revisit-hb' + (pct === null ? ' is-none' : '') });
			setTooltip(row, pct === null ? `${a} · no mature reviews` : `${a} · ${pct}% over ${r?.total ?? 0} reviews`);
			row.createSpan({ cls: 'revisit-hb-name', text: a });
			const track = row.createSpan({ cls: 'revisit-hb-track' });
			if (pct !== null) track.createEl('i').style.width = `${pct}%`;
			track.createEl('b').style.left = `${meta}%`;
			row.createSpan({ cls: 'revisit-hb-val', text: pct === null ? '—' : `${pct}%` });
		}
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
