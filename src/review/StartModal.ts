import { App, Modal, setIcon } from 'obsidian';
import { SessionChoice } from '../srs/session';

const NOTES: Record<number, string> = { 5: 'Fits a coffee break', 10: 'Short', 20: 'A solid session', 30: 'Long' };

/** "How much time do you have?": one row per length with how many cards fit, then Start. */
export class StartModal extends Modal {
	private picked: number | null;

	constructor(
		app: App,
		private o: {
			title: string;
			choices: SessionChoice[];
			/** minutes preselected */
			preselected: number;
			/** cards due today, for the line under the list */
			dueCards: number;
			onStart: (minutes: number | null) => void;
		},
	) {
		super(app);
		this.picked = o.preselected;
	}

	onOpen(): void {
		this.modalEl.addClass('revisit-start-modal');
		this.setTitle(this.o.title);
		this.draw();
	}

	private draw(): void {
		const root = this.contentEl;
		root.empty();
		root.addClass('revisit-start');
		root.createEl('p', { text: 'How much time do you have now?', cls: 'revisit-muted revisit-start-ask' });
		const group = root.createDiv({ cls: 'revisit-choices', attr: { role: 'radiogroup', 'aria-label': 'Session length' } });
		for (const c of this.o.choices) {
			const on = c.minutes === this.picked;
			const row = group.createEl('button', { cls: 'revisit-choice' + (on ? ' is-on' : ''), attr: { role: 'radio', 'aria-checked': String(on) } });
			setIcon(row.createSpan({ cls: 'revisit-choice-icon' }), 'clock');
			const text = row.createSpan({ cls: 'revisit-choice-text' });
			text.createEl('b', { text: c.minutes === null ? 'Everything due' : `${c.minutes} min` });
			text.createSpan({ cls: 'revisit-muted', text: c.minutes === null ? `about ${c.estimate} min` : (NOTES[c.minutes] ?? '') });
			const n = row.createSpan({ cls: 'revisit-choice-n', text: String(c.cards) });
			n.createSpan({ cls: 'revisit-muted', text: c.cards === 1 ? ' card' : ' cards' });
			setIcon(row.createSpan({ cls: 'revisit-choice-check' }), 'check');
			row.onclick = () => {
				this.picked = c.minutes;
				this.draw();
				this.contentEl.querySelector<HTMLElement>('.revisit-choice.is-on')?.focus();
			};
		}
		const sel = this.o.choices.find((c) => c.minutes === this.picked);
		const fits = sel?.cards ?? 0;
		root.createEl('p', {
			cls: 'revisit-muted revisit-start-note',
			text:
				this.o.dueCards === 0
					? 'Nothing is due today.'
					: `${this.o.dueCards} ${this.o.dueCards === 1 ? 'card is' : 'cards are'} due today.${this.picked === null ? '' : ` ${this.picked} min cover${fits === 1 ? 's' : ''} ${fits}, the most forgotten first.`}`,
		});
		const go = root.createEl('button', { text: this.picked === null ? 'Start everything' : `Start ${this.picked} min`, cls: 'mod-cta revisit-start-go' });
		go.disabled = fits === 0;
		go.onclick = () => {
			this.close();
			this.o.onStart(this.picked);
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
