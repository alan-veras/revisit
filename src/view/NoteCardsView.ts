import { topicsLabel } from '../cards/format';
import { ItemView, TFile, WorkspaceLeaf } from 'obsidian';
import { ConfirmModal } from '../ui/ConfirmModal';
import type RevisitPlugin from '../main';

export const VIEW_TYPE_NOTE = 'revisit-note';

/** Side panel: the cards born from the open note, with Edit and a button to review them. */
export class NoteCardsView extends ItemView {
	constructor(
		leaf: WorkspaceLeaf,
		private plugin: RevisitPlugin,
	) {
		super(leaf);
	}
	getViewType(): string {
		return VIEW_TYPE_NOTE;
	}
	getDisplayText(): string {
		return 'Cards of this note';
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
		root.addClass('revisit-note');
		const file = this.plugin.lastSource;
		if (!file) {
			root.createEl('p', { cls: 'revisit-muted', text: 'Open a note or a PDF.' });
			return;
		}
		const cards = this.plugin.cardsOf(file);
		const head = root.createDiv({ cls: 'revisit-note-head' });
		head.createEl('h4', { text: file.basename });
		head.createEl('button', { text: 'New card' }).onclick = () => void this.plugin.captureFor(file);
		if (!cards.length) {
			root.createEl('p', { cls: 'revisit-muted', text: 'No cards from this note yet.' });
			return;
		}
		const reviewable = cards.filter((c) => !this.plugin.isSuspended(c));
		if (reviewable.length) head.createEl('button', { text: `Review ${reviewable.length}`, cls: 'mod-cta' }).onclick = () => void this.plugin.reviewNote(file);
		for (const c of cards) {
			const box = root.createDiv({ cls: 'revisit-note-card' });
			box.createDiv({ cls: 'revisit-note-front', text: c.front.replace(/\s+/g, ' ').slice(0, 140) });
			box.createDiv({ cls: 'revisit-muted revisit-small', text: [c.type, topicsLabel(c.topics), c.reverse ? 'both ways' : ''].filter(Boolean).join(' · ') });
			const b = box.createDiv({ cls: 'revisit-note-btns' });
			b.createEl('button', { text: 'Edit' }).onclick = () => this.plugin.editCard(c, () => this.draw());
			const st = c.id ? this.plugin.store.state[c.id] : undefined;
			if (st?.fsrs) b.createEl('button', { text: 'Reset', attr: { title: "Forgets the schedule: the card comes back as new" } }).onclick = () => void this.plugin.resetCard(c);
			if (!c.inline)
				b.createEl('button', { text: 'Delete', attr: { title: 'Deletes the card after a confirmation' } }).onclick = () =>
					new ConfirmModal(this.plugin.app, 'Delete card', c.front.replace(/\s+/g, ' ').slice(0, 140), 'Delete', () => void this.plugin.deleteCard(c).then(() => this.draw()));
		}
	}
}

export function isSource(f: unknown): f is TFile {
	return f instanceof TFile && (f.extension === 'md' || f.extension === 'pdf');
}
