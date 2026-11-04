import { assuntosLabel } from '../cards/format';
import { ItemView, Menu, Notice, setIcon, setTooltip, TFile, WorkspaceLeaf } from 'obsidian';
import { daysLabel, nextInterval, untilLabel } from '../notes/reread';
import { assuntoTree, TreeNode } from '../srs/tree';
import { forecast } from '../srs/budget';
import { cardRow, EstadoCartao, estadoOf, rowOrder } from '../srs/rows';
import { cardStats, retentionBy, reviewsPerDay } from '../srs/stats';
import { matchesCard } from './search';
import { AREAS } from '../cards/types';
import type LembroPlugin from '../main';
import { estimateMinutes, matchesFilter, QueueItem } from '../srs/queue';
import { isNew } from '../srs/scheduler';

export const VIEW_TYPE_PAINEL = 'lembro-painel';

const ESTADOS: (readonly [EstadoCartao | 'todos', string])[] = [
	['todos', 'Todos os estados'],
	['novo', 'Novo'],
	['aprendendo', 'Aprendendo'],
	['revisao', 'Revisão'],
	['suspenso', 'Suspenso'],
];
const ESTADO_LABEL: Record<EstadoCartao, string> = { novo: 'novo', aprendendo: 'aprendendo', revisao: 'revisão', suspenso: 'suspenso' };

/** One screen: what fits today, the browser, the notes and the progress. */
export class PainelView extends ItemView {
	private q = '';
	/** browser filters */
	private estado: EstadoCartao | 'todos' = 'todos';
	private areaF: string | null = null;
	private limit = 100;
	/** tree rows opened (Área or Área > Assunto paths) */
	private expanded = new Set<string>();
	private tab: 'hoje' | 'buscar' | 'notas' | 'progresso' = 'hoje';
	/** day picked in the next-7-days chart (0 = today); null = the first day with cards */
	private day: number | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LembroPlugin,
	) {
		super(leaf);
	}
	getViewType(): string {
		return VIEW_TYPE_PAINEL;
	}
	getDisplayText(): string {
		return 'Lembro';
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
		root.addClass('lembro-painel');
		const wrap = root.createDiv({ cls: 'lembro-painel-wrap' });
		const tabs = wrap.createDiv({ cls: 'lembro-ptabs' });
		for (const [id, name] of [['hoje', 'Hoje'], ['buscar', 'Buscar'], ['notas', 'Notas'], ['progresso', 'Progresso']] as const) {
			const b = tabs.createEl('button', { text: name, cls: this.tab === id ? 'is-on' : '' });
			b.onclick = () => {
				this.tab = id;
				this.draw();
			};
		}
		if (this.tab === 'progresso') return this.drawProgresso(wrap);
		if (this.tab === 'buscar') return this.drawBuscar(wrap);
		if (this.tab === 'notas') return this.drawNotas(wrap);

		const today = p.session(null);
		const hero = wrap.createDiv({ cls: 'lembro-hero' });
		hero.createDiv({ cls: 'lembro-big', text: String(today.length) });
		hero.createDiv({ cls: 'lembro-muted', text: today.length ? `${today.length === 1 ? 'cartão cabe' : 'cartões cabem'} hoje · uns ${Math.max(1, estimateMinutes(today, p.secs()))} min` : 'nada para hoje' });
		const go = hero.createEl('button', { text: 'Revisar', cls: 'mod-cta lembro-go' });
		go.disabled = !today.length;
		go.onclick = () => void p.review(null);

		this.drawDecks(wrap);
	}

	/** Started once: areas with something for today open on the first draw. */
	private seeded = false;

	/** The decks as a clean tree: pills for what is due (blue) and new (green), the area's cota as a small meter; an open parent shows only its name. */
	private drawDecks(wrap: HTMLElement): void {
		const p = this.plugin;
		const q = p.quota();
		const items = p.items().filter((it) => !it.reverso && !it.cloze);
		const tree = assuntoTree(items.filter((it) => !it.suspended));
		const suspended = assuntoTree(items.filter((it) => it.suspended));
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

		const list = wrap.createDiv({ cls: 'lembro-list' });
		const row = (node: TreeNode, depth: number) => {
			const s = p.session(node.area, undefined, false, node.assunto);
			const newCount = s.filter((it) => isNew(it.fsrs)).length;
			const toReview = s.length - newCount;
			const kids = node.children.length > 0;
			const open = this.expanded.has(node.path);
			const r = list.createDiv({ cls: `lembro-li is-d${Math.min(depth, 3)}` + (s.length ? '' : ' is-quiet') });
			r.style.paddingLeft = `${6 + depth * 20}px`;
			const caret = r.createSpan({ cls: 'lembro-caret' + (open ? ' is-open' : '') });
			if (kids) setIcon(caret, 'chevron-right');
			r.createSpan({ cls: 'lembro-li-title', text: node.name });
			const susp = suspendedOf(node.path);

			// rollup: an open parent is only a title; the numbers live on the deepest visible row
			const summary = !(kids && open);
			const pills = r.createSpan({ cls: 'lembro-li-pills' });
			if (summary && toReview) setTooltip(pills.createSpan({ cls: 'lembro-np is-due', text: String(toReview) }), `${toReview} para revisar hoje`);
			if (summary && newCount) setTooltip(pills.createSpan({ cls: 'lembro-np is-new', text: String(newCount) }), `${newCount} ${newCount === 1 ? 'novo entra' : 'novos entram'} hoje`);

			// nothing for today: say when the next review falls, so the row is never mute
			if (summary && !s.length) {
				const next = items
					.filter((it) => !it.suspended && it.fsrs && !isNew(it.fsrs) && matchesFilter(it, node.area === 'Sem área' ? null : node.area, node.assunto))
					.reduce<Date | null>((m, it) => (it.fsrs && (!m || it.fsrs.due < m) ? it.fsrs.due : m), null);
				if (next) setTooltip(r.createSpan({ cls: 'lembro-li-next', text: untilLabel(next, new Date()) }), `Próxima revisão: ${next.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}`);
			}
			const total = r.createSpan({ cls: 'lembro-li-total', text: summary ? String(node.cards) : '' });
			if (summary) setTooltip(total, `${node.cards} ${node.cards === 1 ? 'cartão ativo' : 'cartões ativos'}${susp ? ` · ${susp} suspensos` : ''}`);

			const cota = depth === 0 ? q.areas.find((a) => a.area === node.area) : undefined;
			const meter = r.createSpan({ cls: 'lembro-li-cota' });
			if (cota) {
				const full = cota.teto > 0 && cota.livres === 0;
				const paused = cota.cota === 0;
				if (full) meter.addClass('is-full');
				const bar = meter.createSpan({ cls: 'lembro-li-bar' });
				bar.createEl('i').style.width = `${cota.teto ? Math.min(100, (cota.usados / cota.teto) * 100) : 0}%`;
				meter.createSpan({ cls: 'lembro-li-cota-n', text: paused ? 'pausado' : `${cota.usados}/${cota.teto}` });
				if (full) setIcon(meter.createSpan({ cls: 'lembro-li-ok' }), 'check');
				setTooltip(meter, paused ? 'Cota 0: novos desta área pausados' : full ? `Cota de novos completa hoje (${cota.teto}): voltam amanhã` : `Novos hoje: ${cota.usados} de ${cota.teto}${q.reduced ? ' · cota encolhida pelo orçamento' : ''}`);
			}

			const go = r.createSpan({ cls: 'lembro-li-go' });
			if (s.length) {
				setIcon(go, 'play');
				setTooltip(go, `Revisar ${node.assunto ?? node.area} (${s.length})`);
				go.onclick = (e) => {
					e.stopPropagation();
					void p.review(node.area, undefined, false, node.assunto);
				};
			}
			if (kids)
				r.onclick = () => {
					if (open) this.expanded.delete(node.path);
					else this.expanded.add(node.path);
					this.draw();
				};
			else if (s.length) r.onclick = () => void p.review(node.area, undefined, false, node.assunto);
			if (open) for (const c of node.children) row(c, depth + 1);
		};
		for (const t of tree) row(t, 0);

		if (q.reduced) list.createDiv({ cls: 'lembro-deck-empty', text: 'As revisões vencidas ocupam o orçamento de minutos: as cotas de novos encolheram hoje.' });
	}

	/** Whole notes to reread: today's, the one being read, and the next ones. */
	private drawNotas(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const due = p.dueRereads(now);
		const all = p.rereadNotes();
		const name = (path: string) => path.split('/').pop()?.replace(/\.md$/, '') ?? path;
		const open = (path: string) => void p.openReread(path);

		const hero = wrap.createDiv({ cls: 'lembro-hero' });
		hero.createDiv({ cls: 'lembro-big', text: String(due.length) });
		hero.createDiv({ cls: 'lembro-muted', text: due.length ? `${due.length === 1 ? 'nota para reler' : 'notas para reler'} hoje` : 'nenhuma nota para reler hoje' });
		const go = hero.createEl('button', { text: 'Ler a próxima', cls: 'mod-cta lembro-go' });
		go.disabled = !due.length;
		go.onclick = () => void p.openNextReread();

		if (p.reading) {
			const path = p.reading;
			const box = wrap.createDiv({ cls: 'lembro-reading' });
			box.createDiv({ cls: 'lembro-muted', text: 'Lendo agora' });
			box.createEl('h3', { text: name(path) });
			box.createDiv({ cls: 'lembro-muted', text: 'Terminou? Diga como foi a releitura:' });
			const prev = all.find((n) => n.path === path)?.r;
			const row = box.createDiv({ cls: 'lembro-reading-btns' });
			for (const [l, nome] of [['dificil', 'Difícil'], ['bom', 'Bom'], ['facil', 'Fácil']] as const) {
				const b = row.createEl('button', { cls: l === 'bom' ? 'mod-cta' : '' });
				b.createEl('b', { text: nome });
				b.createEl('small', { text: daysLabel(nextInterval(prev, l)) });
				b.onclick = () => void p.gradeReread(path, l);
			}
			const skip = box.createEl('button', { text: 'Agora não', cls: 'lembro-link' });
			skip.onclick = () => {
				p.reading = null;
				this.draw();
			};
		}

		if (due.length) {
			wrap.createEl('h4', { text: 'Para hoje', cls: 'lembro-sub' });
			const list = wrap.createDiv({ cls: 'lembro-areas' });
			for (const path of due) {
				const r = all.find((n) => n.path === path)?.r;
				const row = list.createDiv({ cls: 'lembro-area' });
				row.createSpan({ text: name(path) });
				row.createSpan({ cls: 'lembro-area-n', text: r ? `lida ${r.vezes}x` : 'nova' });
				setIcon(row.createSpan({ cls: 'lembro-area-go' }), 'chevron-right');
				row.onclick = () => open(path);
			}
		}

		const later = all
			.filter((n) => n.r && new Date(n.r.due) > now)
			.sort((a, b) => (a.r?.due ?? '').localeCompare(b.r?.due ?? ''))
			.slice(0, 8);
		if (later.length) {
			wrap.createEl('h4', { text: 'Próximas', cls: 'lembro-sub' });
			const list = wrap.createDiv({ cls: 'lembro-areas' });
			for (const n of later) {
				const row = list.createDiv({ cls: 'lembro-area' });
				row.createSpan({ text: name(n.path) });
				row.createSpan({ cls: 'lembro-area-n', text: new Date(n.r?.due ?? '').toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) });
				row.onclick = () => open(n.path);
			}
		}

		wrap.createEl('p', {
			cls: 'lembro-muted lembro-small',
			text: `${all.length} ${all.length === 1 ? 'nota' : 'notas'} na releitura. Para incluir uma nota, clique com o botão direito nela e escolha "Reler esta nota de tempos em tempos"${p.settings.rereadTag ? `, ou use a tag ${p.settings.rereadTag}` : ''}.`,
		});
	}

	/** The browser: search, filters by state and area, and one dense row per card, like the Anki desktop table. */
	private drawBuscar(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const stats = cardStats(p.store.log);

		const bar = wrap.createDiv({ cls: 'lembro-filters' });
		const input = bar.createEl('input', { type: 'search', attr: { placeholder: 'Buscar cartões' } });
		input.value = this.q;
		input.oninput = () => {
			this.q = input.value;
			this.draw();
		};
		const est = bar.createEl('select', { attr: { 'aria-label': 'Estado' } });
		for (const [v, nome] of ESTADOS) {
			const o = est.createEl('option', { text: nome, value: v });
			if (this.estado === v) o.selected = true;
		}
		est.onchange = () => {
			this.estado = est.value as EstadoCartao | 'todos';
			this.draw();
		};
		const sel = bar.createEl('select', { attr: { 'aria-label': 'Área' } });
		for (const a of ['Todas as áreas', ...AREAS, 'Sem área'] as const) {
			const o = sel.createEl('option', { text: a, value: a });
			if ((this.areaF ?? 'Todas as áreas') === a) o.selected = true;
		}
		sel.onchange = () => {
			this.areaF = sel.value === 'Todas as áreas' ? null : sel.value;
			this.draw();
		};

		const clean = this.q.trim() || this.estado !== 'todos' || this.areaF;
		if (!clean) {
			wrap.createDiv({ cls: 'lembro-muted lembro-empty', text: 'Digite para buscar, ou filtre por estado e área.' });
			return;
		}
		const rows = p
			.items()
			.map((it) => cardRow(it, stats, now))
			.filter((r) => (this.estado === 'todos' || r.estado === this.estado) && (!this.areaF || (r.area ?? 'Sem área') === this.areaF))
			.filter((r) => matchesCard(r.item.card, this.q))
			.sort(rowOrder);
		const hoje = rows.filter((r) => r.venceHoje).length;
		wrap.createDiv({
			cls: 'lembro-muted lembro-small lembro-count',
			text: `${rows.length} ${rows.length === 1 ? 'cartão' : 'cartões'}${hoje ? ` · ${hoje} ${hoje === 1 ? 'vence' : 'vencem'} hoje` : ''}`,
		});
		if (!rows.length) {
			wrap.createDiv({ cls: 'lembro-muted lembro-empty', text: 'Nenhum cartão com esses filtros.' });
			return;
		}

		const head = wrap.createDiv({ cls: 'lembro-thead' });
		head.createSpan({ cls: 'lembro-th-c', text: 'Cartão' });
		head.createSpan({ cls: 'lembro-th', text: 'Estado' });
		head.createSpan({ cls: 'lembro-th', text: 'Volta' });
		head.createSpan({ cls: 'lembro-th is-n', text: '✓' });
		head.createSpan({ cls: 'lembro-th is-n', text: '✗' });

		const table = wrap.createDiv({ cls: 'lembro-table' });
		for (const r of rows.slice(0, this.limit)) {
			const row = table.createDiv({ cls: `lembro-tr is-${r.estado}` });
			const c = row.createDiv({ cls: 'lembro-td-c' });
			c.createDiv({ cls: 'lembro-td-f', text: r.frente.replace(/\s+/g, ' ') });
			c.createDiv({ cls: 'lembro-td-sub', text: [r.area ?? 'Sem área', assuntosLabel(r.assuntos), r.lado !== 'frente' ? r.lado : r.tipo].filter(Boolean).join(' · ') });
			row.createSpan({ cls: `lembro-st is-${r.estado}`, text: ESTADO_LABEL[r.estado] });
			row.createSpan({ cls: 'lembro-td-volta', text: r.proxima ? untilLabel(r.proxima, now) : '—' });
			row.createSpan({ cls: 'lembro-td-n is-ok', text: r.ok ? String(r.ok) : '' });
			row.createSpan({ cls: 'lembro-td-n is-bad', text: r.bad ? String(r.bad) : '' });
			const acts = row.createDiv({ cls: 'lembro-td-acts' });
			acts.createEl('button', { text: 'Editar' }).onclick = (e) => {
				e.stopPropagation();
				p.editCard(r.item.card, () => this.draw());
			};
			const more = acts.createEl('button', { text: '⋯', attr: { 'aria-label': 'Mais ações' } });
			more.onclick = (e) => {
				e.stopPropagation();
				this.cardMenu(e, r);
			};
		}
		if (rows.length > this.limit) {
			const more = wrap.createEl('button', { text: `Mostrar mais ${rows.length - this.limit}`, cls: 'lembro-link lembro-more' });
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
			i.setTitle('Revisar os cartões desta nota').setIcon('layers').onClick(() => {
				const src = p.resolveSource(r.item.card);
				const f = src ? p.app.vault.getAbstractFileByPath(src) : null;
				if (f instanceof TFile) void p.reviewNote(f);
				else new Notice('Lembro: a fonte deste cartão não está no vault.');
			}),
		);
		menu.addItem((i) => i.setTitle('Recomeçar: volta como novo').setIcon('rotate-ccw').onClick(() => void p.resetCard(r.item.card)));
		menu.addItem((i) =>
			i
				.setTitle(r.estado === 'suspenso' ? 'Reativar' : 'Suspender')
				.setIcon(r.estado === 'suspenso' ? 'play' : 'pause')
				.onClick(async () => {
					p.store.state[r.id] = { ...(p.store.state[r.id] ?? {}), st: r.estado === 'suspenso' ? 'ativo' : 'suspenso' };
					await p.store.saveState();
					p.updateStatus();
					this.draw();
				}),
		);
		menu.showAtMouseEvent(e);
	}

	private drawProgresso(wrap: HTMLElement): void {
		const p = this.plugin;
		const now = new Date();
		const items = p.items();
		const log = p.store.log;
		const meta = Math.round(p.settings.retention * 100);
		const areaOf = new Map(items.map((i) => [i.key, i.area]));
		const ret = retentionBy(log, (id) => areaOf.get(id) ?? null);
		const all = [...ret.values()].reduce((a, r) => ({ ok: a.ok + r.ok, total: a.total + r.total }), { ok: 0, total: 0 });
		const past = reviewsPerDay(log, now, 30);

		const kpis = wrap.createDiv({ cls: 'lembro-kpis' });
		const kpi = (v: string, label: string, small?: string) => {
			const k = kpis.createDiv({ cls: 'lembro-kpi' });
			const n = k.createDiv({ cls: 'lembro-kpi-v', text: v });
			if (small) n.createSpan({ cls: 'lembro-muted lembro-kpi-s', text: small });
			k.createDiv({ cls: 'lembro-muted lembro-small', text: label });
		};
		kpi(all.total ? `${Math.round((all.ok / all.total) * 100)}%` : '—', `acerto nos maduros · meta ${meta}%`);
		kpi(String(past.filter((x) => x > 0).length), 'dias com sessão', ' / 30');
		kpi(String(p.store.cards.length), 'cartões no total');

		const by = { novo: 0, aprendendo: 0, revisao: 0, suspenso: 0 };
		for (const it of items) by[estadoOf(it)]++;
		const strip = wrap.createDiv({ cls: 'lembro-estados' });
		for (const e of ['novo', 'aprendendo', 'revisao', 'suspenso'] as const) {
			const n = by[e];
			const pill = strip.createSpan({ cls: `lembro-st is-${e}${n ? '' : ' is-zero'}`, text: `${ESTADO_LABEL[e]} ${n}` });
			setTooltip(pill, `${n} ${n === 1 ? 'cartão' : 'cartões'} ${ESTADO_LABEL[e]}s`);
		}

		const chart = (title: string, sub: string) => {
			const c = wrap.createDiv({ cls: 'lembro-chart' });
			c.createEl('h4', { text: title });
			c.createDiv({ cls: 'lembro-muted lembro-small', text: sub });
			return c;
		};
		const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
		const budget = p.settings.budgetMinutes;
		const fut = forecast(items, p.secs(), now).map((m) => Math.ceil(m));
		const lab7 = fut.map((_, i) => (i === 0 ? 'hoje' : i === 1 ? 'amanhã' : (DIAS[(now.getDay() + i) % 7] as string)));
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
		const next = chart('Próximos 7 dias', 'Minutos previstos por dia; clique num dia para ver os cartões');
		cols(
			next,
			fut,
			lab7,
			fut.map((v, i) => `${lab7[i] ?? ''} · ${byDay[i]?.length ?? 0} cartões · ~${v} min${v > budget ? ' · passa do orçamento' : ''}`),
			budget,
			pick,
			(i) => {
				this.day = i;
				this.draw();
			},
		);
		const list = next.createDiv({ cls: 'lembro-daylist' });
		const cards = byDay[pick] ?? [];
		list.createDiv({ cls: 'lembro-daylist-h', text: `${lab7[pick] ?? ''}: ${cards.length ? `${cards.length} ${cards.length === 1 ? 'cartão' : 'cartões'}` : 'nenhum cartão'}` });
		for (const it of cards) {
			const row = list.createDiv({ cls: 'lembro-result' });
			const t = row.createDiv({ cls: 'lembro-result-t' });
			t.createDiv({ cls: 'lembro-result-f', text: it.card.frente.replace(/\s+/g, ' ') });
			t.createDiv({ cls: 'lembro-muted lembro-small', text: [it.area ?? 'Sem área', assuntosLabel(it.card.assuntos), it.card.tipo].filter(Boolean).join(' · ') });
			row.createEl('button', { text: 'Editar' }).onclick = () => p.editCard(it.card, () => this.draw());
		}
		const day = (i: number) => new Date(now.getTime() - (29 - i) * 86400000);
		cols(
			chart('Últimos 30 dias', `${past.reduce((a, b) => a + b, 0)} revisões; dias sem barra não tiveram sessão`),
			past,
			past.map((_, i) => (i % 7 === 1 || i === 29 ? String(day(i).getDate()) : '')),
			past.map((v, i) => `${day(i).getDate()}/${day(i).getMonth() + 1} · ${v ? `${v} revisões` : 'sem sessão'}`),
		);

		const hb = chart('Acerto por área', `Cartões vistos há 7 dias ou mais; o traço é a meta de ${meta}%`).createDiv({ cls: 'lembro-hbars' });
		for (const a of AREAS) {
			const r = ret.get(a);
			const pct = r ? Math.round((r.ok / r.total) * 100) : null;
			const row = hb.createDiv({ cls: 'lembro-hb' + (pct === null ? ' is-none' : '') });
			setTooltip(row, pct === null ? `${a} · sem revisões maduras` : `${a} · ${pct}% em ${r?.total ?? 0} revisões`);
			row.createSpan({ cls: 'lembro-hb-name', text: a });
			const track = row.createSpan({ cls: 'lembro-hb-track' });
			if (pct !== null) track.createEl('i').style.width = `${pct}%`;
			track.createEl('b').style.left = `${meta}%`;
			row.createSpan({ cls: 'lembro-hb-val', text: pct === null ? '—' : `${pct}%` });
		}
	}
}

/** Single-series columns, one hue, optional limit line; the value shows on hover. */
function cols(parent: HTMLElement, values: number[], labels: string[], tips: string[], limit?: number, picked?: number, onPick?: (i: number) => void): void {
	const max = Math.max(1, limit ?? 0, ...values) * 1.1;
	const box = parent.createDiv({ cls: 'lembro-cols' });
	if (limit) {
		const line = box.createDiv({ cls: 'lembro-limit' });
		line.style.bottom = `${(limit / max) * 100}%`;
		line.createSpan({ text: `orçamento ${limit} min` });
	}
	values.forEach((v, i) => {
		const col = box.createDiv({ cls: 'lembro-col' + (onPick ? ' is-click' : '') + (picked === i ? ' is-picked' : '') });
		if (onPick) col.onclick = () => onPick(i);
		setTooltip(col, tips[i] ?? '');
		col.createEl('i').style.height = `${(v / max) * 100}%`;
	});
	const xl = parent.createDiv({ cls: 'lembro-xl' });
	labels.forEach((l, i) => xl.createSpan({ text: l, cls: picked === i ? 'is-picked' : '' }));
}
