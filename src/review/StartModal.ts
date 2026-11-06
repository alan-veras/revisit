import { App, Modal, setIcon } from 'obsidian';
import { CatchUpOffer, planDaysText } from '../srs/forecast';
import { SessionChoice, visibleChoices } from '../srs/session';

const NOTES: Record<number, string> = { 5: 'Fits a coffee break', 10: 'Short', 20: 'A solid session', 30: 'Long' };
/** One colour per row, by position, so the lengths read at a glance. */
const TONES = ['green', 'cyan', 'blue', 'purple', 'orange'];

/** "How much time do you have?": one row per length that changes the outcome, then Start. */
export class StartModal extends Modal {
	private picked: number | null;

	private rows: SessionChoice[];

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
			/** large overdue backlog: offer to work through it gradually */
			catchUp?: { offer: CatchUpOffer; onStart: () => void };
		},
	) {
		super(app);
		this.rows = visibleChoices(o.choices);
		this.picked = this.rows.some((c) => c.minutes === o.preselected) ? o.preselected : null;
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
		const cu = this.o.catchUp;
		if (cu) {
			const b = root.createDiv({ cls: 'revisit-catchup', attr: { role: 'region', 'aria-label': 'Catch up' } });
			const head = b.createDiv({ cls: 'revisit-catchup-text' });
			setIcon(head.createSpan({ cls: 'revisit-catchup-icon' }), 'alert-triangle');
			head.createSpan({ text: `You have ${cu.offer.overdue} overdue ${cu.offer.overdue === 1 ? 'card' : 'cards'} (about ${Math.round(cu.offer.overdueMinutes)} min). Catch up gradually?` });
			b.createDiv({ cls: 'revisit-muted revisit-catchup-plan', text: `Today: ${cu.offer.todayKeys.length} ${cu.offer.todayKeys.length === 1 ? 'card' : 'cards'}, about ${Math.max(1, Math.round(cu.offer.todayMinutes))} min. The plan takes ${planDaysText(cu.offer)}.` });
			const btn = b.createEl('button', { text: "Start today's catch-up", cls: 'revisit-catchup-go' });
			btn.onclick = () => {
				this.close();
				cu.onStart();
			};
		}
		root.createEl('p', { text: 'How much time do you have now?', cls: 'revisit-muted revisit-start-ask' });
		const group = root.createDiv({ cls: 'revisit-choices', attr: { role: 'radiogroup', 'aria-label': 'Session length' } });
		this.rows.forEach((c, i) => {
			const on = c.minutes === this.picked;
			const row = group.createEl('button', { cls: `revisit-choice tone-${TONES[i % TONES.length]}` + (on ? ' is-on' : ''), attr: { role: 'radio', 'aria-checked': String(on) } });
			setIcon(row.createSpan({ cls: 'revisit-choice-icon' }), 'clock');
			const text = row.createSpan({ cls: 'revisit-choice-text' });
			text.createEl('b', { text: c.minutes === null ? 'Everything due' : `${c.minutes} min` });
			text.createSpan({ cls: 'revisit-muted', text: c.minutes === null ? `about ${c.estimate} min` : (NOTES[c.minutes] ?? '') });
			setIcon(row.createSpan({ cls: 'revisit-choice-check' }), 'check');
			row.onclick = () => {
				this.picked = c.minutes;
				this.draw();
				this.contentEl.querySelector<HTMLElement>('.revisit-choice.is-on')?.focus();
			};
		});
		const sel = this.rows.find((c) => c.minutes === this.picked);
		const fits = sel?.cards ?? 0;
		const plural = (n: number): string => (n === 1 ? 'card' : 'cards');
		root.createEl('p', {
			cls: 'revisit-muted revisit-start-note',
			text:
				this.o.dueCards === 0
					? 'Nothing is due today.'
					: this.picked === null
						? `${this.o.dueCards} ${plural(this.o.dueCards)}, about ${Math.max(1, sel?.estimate ?? 1)} min.`
						: `${fits} of ${this.o.dueCards} ${plural(this.o.dueCards)} due today, the most forgotten first.`,
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
