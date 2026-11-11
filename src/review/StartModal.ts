import { App, Modal, Notice } from 'obsidian';
import { SESSION_MINUTES, SessionChoice } from '../srs/session';

/** One colour per button, so the lengths read at a glance. */
const TONES = ['green', 'cyan', 'blue', 'purple'];

/**
 * The launcher: "How much time do you have today?" — the deck is already on the
 * card, so one tap on a length starts the session.
 */
export class StartModal extends Modal {
	private custom = false;

	constructor(
		app: App,
		private o: {
			title: string;
			/** one choice per quick length, plus "everything due" (minutes null) last, for the counts */
			choices: SessionChoice[];
			/** minutes suggested in the custom field */
			suggested: number;
			onStart: (minutes: number) => void;
		},
	) {
		super(app);
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
		root.createEl('p', { text: 'How much time do you have today?', cls: 'revisit-start-ask' });
		if (this.custom) return this.drawCustom(root);
		const group = root.createDiv({ cls: 'revisit-quick', attr: { role: 'group', 'aria-label': 'Session length' } });
		SESSION_MINUTES.forEach((m, i) => {
			const fit = this.o.choices.find((c) => c.minutes === m);
			const row = group.createEl('button', { cls: `revisit-choice tone-${TONES[i % TONES.length]}`, attr: { 'aria-label': `${m} minutes` } });
			row.createEl('b', { text: `${m} min` });
			row.createSpan({ cls: 'revisit-muted', text: fit ? `${fit.cards} ${fit.cards === 1 ? 'card' : 'cards'}` : '' });
			row.disabled = !fit || fit.cards === 0;
			row.onclick = () => {
				this.close();
				this.o.onStart(m);
			};
		});
		const custom = group.createEl('button', { cls: `revisit-choice tone-${TONES[TONES.length - 1]}`, attr: { 'aria-label': 'Custom length' } });
		custom.createEl('b', { text: 'Custom' });
		custom.createSpan({ cls: 'revisit-muted', text: 'pick a length' });
		custom.onclick = () => {
			this.custom = true;
			this.draw();
		};
	}

	private drawCustom(root: HTMLElement): void {
		const box = root.createDiv({ cls: 'revisit-custom' });
		const input = box.createEl('input', { type: 'number', cls: 'revisit-custom-input', attr: { min: '1', max: '600', step: '1', 'aria-label': 'Minutes' } });
		input.value = String(this.o.suggested);
		const go = box.createEl('button', { text: 'Start', cls: 'mod-cta' });
		const submit = (): void => {
			const raw = Math.floor(Number(input.value));
			if (!Number.isFinite(raw) || raw < 1) {
				input.focus();
				return;
			}
			if (raw > 600) new Notice('Revisit: the maximum session is 600 min.');
			this.close();
			this.o.onStart(Math.min(raw, 600));
		};
		go.onclick = submit;
		input.onkeydown = (e) => {
			if (e.key === 'Enter') submit();
		};
		window.setTimeout(() => input.focus(), 50);
		root.createEl('button', { text: 'Back', cls: 'revisit-start-back' }).onclick = () => {
			this.custom = false;
			this.draw();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
