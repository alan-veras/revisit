import { App, SuggestModal } from 'obsidian';
import { subdeckName } from '../core/decks';

/** Where a card goes: one of the decks, or a new path typed with `/` between levels. */
export class DeckPicker extends SuggestModal<string> {
	constructor(
		app: App,
		private decks: string[],
		private pick: (deck: string) => void,
	) {
		super(app);
		this.setPlaceholder('Move to deck…');
	}

	getSuggestions(query: string): string[] {
		const typed = query.split('/').map(subdeckName).filter(Boolean).join('/');
		const q = typed.toLowerCase();
		const found = this.decks.filter((d) => d.toLowerCase().includes(q));
		return typed && !this.decks.some((d) => d.toLowerCase() === q) ? [...found, typed] : found;
	}

	renderSuggestion(deck: string, el: HTMLElement): void {
		const name = deck.split('/').join(' › ');
		el.setText(this.decks.includes(deck) ? name : `New deck: ${name}`);
	}

	onChooseSuggestion(deck: string): void {
		this.pick(deck);
	}
}
