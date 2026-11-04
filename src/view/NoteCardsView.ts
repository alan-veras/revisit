import { assuntosLabel } from '../cards/format';
import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import type LembroPlugin from '../main';

export const VIEW_TYPE_NOTE = 'lembro-nota';

/** Side panel: the cards born from the open note, with Editar and a button to review them. */
export class NoteCardsView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LembroPlugin,
	) {
		super(leaf);
	}
	getViewType(): string {
		return VIEW_TYPE_NOTE;
	}
	getDisplayText(): string {
		return 'Cartões desta nota';
	}
	getIcon(): string {
		return 'layers';
	}
	async onOpen(): Promise<void> {
		this.draw();
	}

	draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('lembro-note');
		const file = this.plugin.lastSource;
		if (!file) {
			root.createEl('p', { cls: 'lembro-muted', text: 'Abra uma nota ou um PDF.' });
			return;
		}
		const cards = this.plugin.cardsOf(file);
		const head = root.createDiv({ cls: 'lembro-note-head' });
		head.createEl('h4', { text: file.basename });
		if (!cards.length) {
			root.createEl('p', { cls: 'lembro-muted', text: 'Nenhum cartão nasceu desta nota ainda.' });
			return;
		}
		const reviewable = cards.filter((c) => !this.plugin.isSuspended(c));
		if (reviewable.length) head.createEl('button', { text: `Revisar ${reviewable.length}`, cls: 'mod-cta' }).onclick = () => void this.plugin.reviewNote(file);
		for (const c of cards) {
			const box = root.createDiv({ cls: 'lembro-note-card' });
			box.createDiv({ cls: 'lembro-note-front', text: c.frente.replace(/\s+/g, ' ').slice(0, 140) });
			box.createDiv({ cls: 'lembro-muted lembro-small', text: [c.tipo, assuntosLabel(c.assuntos), c.reverso ? 'dois sentidos' : ''].filter(Boolean).join(' · ') });
			const b = box.createDiv({ cls: 'lembro-note-btns' });
			b.createEl('button', { text: 'Editar' }).onclick = () => this.plugin.editCard(c, () => this.draw());
			const st = c.id ? this.plugin.store.state[c.id] : undefined;
			if (st?.fsrs) b.createEl('button', { text: 'Recomeçar', attr: { title: 'Esquece a agenda: o cartão volta como novo' } }).onclick = () => void this.plugin.resetCard(c);
		}
	}
}

export function isSource(f: unknown): f is TFile {
	return f instanceof TFile && (f.extension === 'md' || f.extension === 'pdf');
}
