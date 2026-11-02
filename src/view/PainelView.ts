import { ItemView, setIcon, setTooltip, WorkspaceLeaf } from 'obsidian';
import { forecast } from '../srs/budget';
import { retentionBy, reviewsPerDay } from '../srs/stats';
import { cardSnippet } from './search';
import { AREAS } from '../cards/types';
import type LembroPlugin from '../main';
import { estimateMinutes, QueueItem } from '../srs/queue';
import { isNew } from '../srs/scheduler';

export const VIEW_TYPE_PAINEL = 'lembro-painel';

/** One screen: what fits today, the areas, and a search over every card. */
export class PainelView extends ItemView {
	private q = '';
	private tab: 'hoje' | 'progresso' = 'hoje';
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
		for (const [id, name] of [['hoje', 'Hoje'], ['progresso', 'Progresso']] as const) {
			const b = tabs.createEl('button', { text: name, cls: this.tab === id ? 'is-on' : '' });
			b.onclick = () => {
				this.tab = id;
				this.draw();
			};
		}
		if (this.tab === 'progresso') return this.drawProgresso(wrap);

		const today = p.session(null);
		const hero = wrap.createDiv({ cls: 'lembro-hero' });
		hero.createDiv({ cls: 'lembro-big', text: String(today.length) });
		hero.createDiv({ cls: 'lembro-muted', text: today.length ? `${today.length === 1 ? 'cartão cabe' : 'cartões cabem'} hoje · uns ${Math.max(1, estimateMinutes(today, p.secs()))} min` : 'nada para hoje' });
		const go = hero.createEl('button', { text: 'Revisar', cls: 'mod-cta lembro-go' });
		go.disabled = !today.length;
		go.onclick = () => void p.review(null);

		const areas = wrap.createDiv({ cls: 'lembro-areas' });
		for (const a of AREAS) {
			const n = p.session(a).length;
			const row = areas.createDiv({ cls: 'lembro-area' + (n ? '' : ' is-zero') });
			row.createSpan({ text: a });
			row.createSpan({ cls: 'lembro-area-n', text: n ? String(n) : '—' });
			const icon = row.createSpan({ cls: 'lembro-area-go' });
			if (n) {
				setIcon(icon, 'chevron-right');
				row.onclick = () => void p.review(a);
			}
		}

		const search = wrap.createDiv({ cls: 'lembro-search' });
		const input = search.createEl('input', { type: 'search', attr: { placeholder: 'Buscar cartões' } });
		input.value = this.q;
		const results = wrap.createDiv({ cls: 'lembro-results' });
		input.oninput = () => {
			this.q = input.value;
			this.drawResults(results);
		};
		this.drawResults(results);
	}

	private drawResults(el: HTMLElement): void {
		el.empty();
		if (!this.q.trim()) return;
		const p = this.plugin;
		const hits = p.store.cards.map((c) => ({ c, m: cardSnippet(c, this.q) })).filter((h) => h.m);
		if (!hits.length) {
			el.createDiv({ cls: 'lembro-muted lembro-empty', text: `Nenhum cartão com “${this.q.trim()}”.` });
			return;
		}
		for (const { c, m } of hits.slice(0, 50)) {
			const row = el.createDiv({ cls: 'lembro-result' });
			const t = row.createDiv({ cls: 'lembro-result-t' });
			t.createDiv({ cls: 'lembro-result-f', text: c.frente.replace(/\s+/g, ' ') });
			if (m) {
				const sn = t.createDiv({ cls: 'lembro-snippet' });
				sn.createSpan({ cls: 'lembro-snippet-campo', text: `${m.campo}: ` });
				sn.appendText(m.before);
				sn.createEl('mark', { text: m.hit });
				sn.appendText(m.after);
			}
			t.createDiv({ cls: 'lembro-muted lembro-small', text: [p.areaOfCard(c) ?? 'Sem área', c.assuntos.join('; '), c.tipo].filter(Boolean).join(' · ') });
			row.createEl('button', { text: 'Editar' }).onclick = () => p.editCard(c, () => this.draw());
		}
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
			t.createDiv({ cls: 'lembro-muted lembro-small', text: [it.area ?? 'Sem área', it.card.assuntos.join('; '), it.card.tipo].filter(Boolean).join(' · ') });
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
