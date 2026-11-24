import { App, Modal, Notice } from 'obsidian';
import { resolveOnSave } from '../core/format';
import type { Card } from '../core/types';

export interface Draft {
	front: string;
	back: string;
	/** topics, shown as small read-only text; they come from the note path or the card being edited */
	topics: string[];
	source: string;
	/** paragraph around the selection, for a cloze */
	context: string;
	/** the card being edited, when there is one */
	card?: Card;
}

/** Two fields, Front and Back. Ctrl+Enter saves, Esc cancels. */
export class CreateModal extends Modal {
	constructor(
		app: App,
		private draft: Draft,
		private onSave: (r: { type: string; front: string; back: string }) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, draft } = this;
		this.modalEl.addClass('revisit-create');
		this.setTitle(draft.card ? 'Edit card' : 'New card');
		contentEl.createDiv({ cls: 'revisit-area', text: draft.topics.length ? `Area: ${draft.topics.join('; ')}` : 'No area' });
		const front = this.box('Front', draft.front, (v) => (draft.front = v));
		const back = this.box('Back', draft.back, (v) => (draft.back = v));
		const save = async () => {
			const r = resolveOnSave(draft);
			if ('error' in r) {
				new Notice(r.error);
				(r.focus === 'front' ? front : back).focus();
				return;
			}
			try {
				await this.onSave(r);
				this.close();
			} catch (e) {
				new Notice(`Revisit: ${e instanceof Error ? e.message : String(e)}`);
			}
		};
		const row = contentEl.createDiv({ cls: 'revisit-create-foot' });
		row.createSpan({ cls: 'revisit-area', text: 'Ctrl+Enter saves' });
		row.createEl('button', { text: 'Save', cls: 'mod-cta' }).onclick = () => void save();
		this.scope.register(['Mod'], 'Enter', () => {
			void save();
			return false;
		});
		window.setTimeout(() => front.focus(), 30);
	}

	private box(label: string, value: string, set: (v: string) => void): HTMLTextAreaElement {
		const wrap = this.contentEl.createDiv({ cls: 'revisit-field' });
		wrap.createEl('label', { text: label });
		const ta = wrap.createEl('textarea', { attr: { rows: '4' } });
		ta.value = value;
		ta.oninput = () => set(ta.value);
		return ta;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
