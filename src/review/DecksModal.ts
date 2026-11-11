import { App, Modal } from 'obsidian';

export interface DeckRow {
	/** the deck name; null is the All cards row */
	topic: string | null;
	label: string;
	/** cards that fit today's budget in this deck */
	due: number;
	/** active cards in the deck, due or not */
	total: number;
}

/** "Which deck do you want to review?": every deck of the vault, one tap picks it. */
export class DecksModal extends Modal {
	constructor(
		app: App,
		private rows: DeckRow[],
		private onPick: (topic: string | null) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass('revisit-start-modal');
		this.setTitle('Decks');
		const root = this.contentEl;
		root.addClass('revisit-start');
		root.createEl('p', { text: 'Which deck do you want to review?', cls: 'revisit-start-ask' });
		const list = root.createDiv({ cls: 'revisit-decks', attr: { role: 'listbox', 'aria-label': 'Deck' } });
		for (const d of this.rows) {
			const row = list.createEl('button', {
				cls: 'revisit-deck' + (d.topic === null ? ' is-all' : '') + (d.due ? '' : ' is-empty'),
				attr: { role: 'option', 'aria-label': `${d.label}: ${d.due} due, ${d.total} cards` },
			});
			row.createSpan({ cls: 'revisit-deck-name', text: d.label });
			row.createSpan({ cls: 'revisit-deck-counts', text: d.due ? `${d.due} due · ${d.total} cards` : `${d.total} cards, nothing due` });
			if (!d.due) row.disabled = true;
			else
				row.onclick = () => {
					this.close();
					this.onPick(d.topic);
				};
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
