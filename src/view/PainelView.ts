import { ItemView, setIcon, WorkspaceLeaf } from 'obsidian';
import { AREAS } from '../cards/types';
import type LembroPlugin from '../main';
import { estimateMinutes } from '../srs/queue';

export const VIEW_TYPE_PAINEL = 'lembro-painel';

/** Without accents and case, so `fe` finds `fé`. */
export function fold(text: string): string {
	return text
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase();
}

/** One screen: what fits today, the areas, and a search over every card. */
export class PainelView extends ItemView {
	private q = '';

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
		const q = fold(this.q.trim());
		if (!q) return;
		const p = this.plugin;
		const hits = p.store.cards.filter((c) => fold(`${c.frente} ${c.verso} ${c.assuntos.join(' ')} ${c.fonte}`).includes(q));
		if (!hits.length) {
			el.createDiv({ cls: 'lembro-muted lembro-empty', text: `Nenhum cartão com “${this.q.trim()}”.` });
			return;
		}
		for (const c of hits.slice(0, 50)) {
			const row = el.createDiv({ cls: 'lembro-result' });
			const t = row.createDiv({ cls: 'lembro-result-t' });
			t.createDiv({ cls: 'lembro-result-f', text: c.frente.replace(/\s+/g, ' ') });
			t.createDiv({ cls: 'lembro-muted lembro-small', text: [p.areaOfCard(c) ?? 'Sem área', c.assuntos.join('; '), c.tipo].filter(Boolean).join(' · ') });
			row.createEl('button', { text: 'Editar' }).onclick = () => p.editCard(c, () => this.draw());
		}
	}
}
