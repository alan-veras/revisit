import { App, Modal } from 'obsidian';
import { normalizeTopic } from '../cards/format';

/**
 * One text field for a topic path (`Kubernetes > Workloads`), with the topics
 * already in use suggested. Several topics go separated by `;`; empty removes.
 */
export class TopicModal extends Modal {
	constructor(
		app: App,
		private value: string,
		private known: string[],
		private title: string,
		private placeholder: string,
		private onSubmit: (topics: string[]) => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.contentEl.createEl('h3', { text: this.title });
		const box = this.contentEl.createDiv({ cls: 'revisit-field' });
		const listId = `revisit-topics-${Date.now()}`;
		const input = box.createEl('input', { type: 'text', value: this.value, attr: { list: listId, placeholder: this.placeholder } });
		const dl = box.createEl('datalist', { attr: { id: listId } });
		for (const t of this.known) dl.createEl('option', { value: t });
		const row = this.contentEl.createDiv({ cls: 'revisit-buttons' });
		row.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
		const go = row.createEl('button', { text: 'Save', cls: 'mod-cta' });
		const submit = (): void => {
			this.close();
			this.onSubmit(input.value.split(';').map(normalizeTopic).filter(Boolean));
		};
		go.onclick = submit;
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
		window.setTimeout(() => input.focus(), 30);
	}
}
