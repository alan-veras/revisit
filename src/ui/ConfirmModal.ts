import { App, Modal } from 'obsidian';

/** Yes/no window for a destructive action: one line of context and a warning button. */
export class ConfirmModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl('h3', { text: this.title });
		this.contentEl.createEl('p', { text: this.body });
		const row = this.contentEl.createDiv({ cls: 'revisit-buttons' });
		row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
		const go = row.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
		go.onclick = () => {
			this.close();
			this.onConfirm();
		};
	}
}
