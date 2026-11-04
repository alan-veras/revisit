import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import { normalizeTopic } from '../cards/format';
import { AREAS, Card, CardType, CARD_TYPES } from '../cards/types';
import { resolveOnSave } from './autoType';

export interface CaptureDraft {
	type: CardType;
	front: string;
	back: string;
	area: string;
	topic: string;
	source: string;
	/** paragraph around the selection, for a cloze */
	context: string;
	/** where the source note is, to resolve links in the preview */
	sourcePath: string;
	reverse?: boolean;
}

export interface CaptureResult {
	type: CardType;
	front: string;
	back: string;
	area: string;
	topics: string[];
	source: string;
	reverse: boolean;
}

/** The capture window: one front, one back, the area and the subject. */
export class CaptureModal extends Modal {
	private draft: CaptureDraft;
	private preview: HTMLElement | null = null;
	private component = new Component();
	private chips: HTMLButtonElement[] = [];

	constructor(
		app: App,
		draft: CaptureDraft,
		private topics: string[],
		private title: string,
		private onSave: (r: CaptureResult) => Promise<void>,
		private focusBack = false,
	) {
		super(app);
		this.draft = { ...draft };
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('revisit-capture');
		this.component.load();
		contentEl.createEl('h3', { text: this.title });

		const chips = contentEl.createDiv({ cls: 'revisit-chips' });
		CARD_TYPES.forEach((t, i) => {
			const b = chips.createEl('button', { text: t, attr: { title: `Ctrl+${i + 1}` } });
			b.onclick = () => this.setTipo(t);
			this.chips.push(b);
		});
		this.markTipo();

		const front = this.area(contentEl, 'Frente', this.draft.front, 'A pergunta', (v) => (this.draft.front = v));
		const back = this.area(contentEl, 'Verso', this.draft.back, 'A resposta', (v) => (this.draft.back = v));

		const row = contentEl.createDiv({ cls: 'revisit-row' });
		const areaBox = row.createDiv({ cls: 'revisit-field' });
		areaBox.createEl('label', { text: 'Área' });
		const sel = areaBox.createEl('select');
		for (const a of AREAS) sel.createEl('option', { text: a, value: a });
		sel.value = this.draft.area || AREAS[0];
		this.draft.area = sel.value;
		sel.onchange = () => (this.draft.area = sel.value);

		const asBox = row.createDiv({ cls: 'revisit-field revisit-grow' });
		asBox.createEl('label', { text: 'Assunto' });
		const listId = `revisit-topics-${Date.now()}`;
		const as = asBox.createEl('input', { type: 'text', value: this.draft.topic, attr: { list: listId, placeholder: 'Assunto > subassunto; outro' } });
		const dl = asBox.createEl('datalist', { attr: { id: listId } });
		for (const a of this.topics) dl.createEl('option', { value: a });
		as.oninput = () => (this.draft.topic = as.value);

		const fonteBox = contentEl.createDiv({ cls: 'revisit-field' });
		fonteBox.createEl('label', { text: 'Fonte' });
		const source = fonteBox.createEl('input', { type: 'text', value: this.draft.source });
		source.oninput = () => (this.draft.source = source.value);

		const rev = contentEl.createEl('label', { cls: 'revisit-check' });
		const cb = rev.createEl('input', { type: 'checkbox' });
		cb.checked = !!this.draft.reverse;
		cb.onchange = () => (this.draft.reverse = cb.checked);
		rev.appendText(' Revisar nos dois sentidos (o back também vira pergunta)');

		contentEl.createEl('label', { text: 'Prévia', cls: 'revisit-label' });
		this.preview = contentEl.createDiv({ cls: 'revisit-preview' });
		void this.renderPreview();

		const buttons = contentEl.createDiv({ cls: 'revisit-buttons' });
		buttons.createEl('button', { text: 'Cancelar' }).onclick = () => this.close();
		const save = buttons.createEl('button', { text: 'Salvar (Ctrl+Enter)', cls: 'mod-cta' });
		save.onclick = () => void this.save();

		contentEl.createDiv({ cls: 'revisit-tip', text: 'Uma coisa por cartão. A pergunta tem uma resposta certa.' });

		this.scope.register(['Mod'], 'Enter', (e) => {
			e.preventDefault();
			void this.save();
			return false;
		});
		CARD_TYPES.forEach((t, i) =>
			this.scope.register(['Mod'], String(i + 1), (e) => {
				e.preventDefault();
				this.setTipo(t);
				return false;
			}),
		);
		window.setTimeout(() => (this.focusBack ? back : front).focus(), 30);
	}

	private area(parent: HTMLElement, label: string, value: string, placeholder: string, set: (v: string) => void): HTMLTextAreaElement {
		const box = parent.createDiv({ cls: 'revisit-field' });
		box.createEl('label', { text: label });
		const ta = box.createEl('textarea', { attr: { rows: '3', placeholder } });
		ta.value = value;
		ta.oninput = () => {
			set(ta.value);
			void this.renderPreview();
		};
		return ta;
	}

	private setTipo(t: CardType): void {
		this.draft.type = t;
		this.markTipo();
	}

	private markTipo(): void {
		this.chips.forEach((b) => b.toggleClass('is-on', b.textContent === this.draft.type));
	}

	private async renderPreview(): Promise<void> {
		if (!this.preview) return;
		this.preview.empty();
		const f = this.preview.createDiv({ cls: 'revisit-preview-front' });
		const b = this.preview.createDiv({ cls: 'revisit-preview-back' });
		await MarkdownRenderer.render(this.app, this.draft.front || '…', f, this.draft.sourcePath, this.component);
		await MarkdownRenderer.render(this.app, this.draft.back || '…', b, this.draft.sourcePath, this.component);
	}

	private async save(): Promise<void> {
		const r = resolveOnSave({ type: this.draft.type, front: this.draft.front, back: this.draft.back, context: this.draft.context });
		if ('error' in r) {
			new Notice(r.error);
			return;
		}
		const topics = this.draft.topic
			.split(';')
			.map(normalizeTopic)
			.filter(Boolean);
		try {
			await this.onSave({ ...r, area: this.draft.area, topics, source: this.draft.source.trim(), reverse: !!this.draft.reverse });
			this.close();
		} catch (e) {
			new Notice(`Lembro: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}
}

export function draftFromCard(card: Card, area: string, sourcePath: string): CaptureDraft {
	return {
		type: card.type,
		front: card.front,
		back: card.back,
		area,
		topic: card.topics.join('; '),
		source: card.source,
		context: '',
		sourcePath,
		reverse: !!card.reverse,
	};
}
