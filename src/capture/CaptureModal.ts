import { App, Component, MarkdownRenderer, Modal, Notice } from 'obsidian';
import { normalizeAssunto } from '../cards/format';
import { AREAS, Card, Tipo, TIPOS } from '../cards/types';
import { resolveOnSave } from './autoType';

export interface CaptureDraft {
	tipo: Tipo;
	frente: string;
	verso: string;
	area: string;
	assunto: string;
	fonte: string;
	/** paragraph around the selection, for a cloze */
	context: string;
	/** where the source note is, to resolve links in the preview */
	sourcePath: string;
}

export interface CaptureResult {
	tipo: Tipo;
	frente: string;
	verso: string;
	area: string;
	assuntos: string[];
	fonte: string;
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
		private assuntos: string[],
		private title: string,
		private onSave: (r: CaptureResult) => Promise<void>,
		private focusBack = false,
	) {
		super(app);
		this.draft = { ...draft };
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('lembro-capture');
		this.component.load();
		contentEl.createEl('h3', { text: this.title });

		const chips = contentEl.createDiv({ cls: 'lembro-chips' });
		TIPOS.forEach((t, i) => {
			const b = chips.createEl('button', { text: t, attr: { title: `Ctrl+${i + 1}` } });
			b.onclick = () => this.setTipo(t);
			this.chips.push(b);
		});
		this.markTipo();

		const front = this.area(contentEl, 'Frente', this.draft.frente, 'A pergunta', (v) => (this.draft.frente = v));
		const back = this.area(contentEl, 'Verso', this.draft.verso, 'A resposta', (v) => (this.draft.verso = v));

		const row = contentEl.createDiv({ cls: 'lembro-row' });
		const areaBox = row.createDiv({ cls: 'lembro-field' });
		areaBox.createEl('label', { text: 'Área' });
		const sel = areaBox.createEl('select');
		for (const a of AREAS) sel.createEl('option', { text: a, value: a });
		sel.value = this.draft.area || AREAS[0];
		this.draft.area = sel.value;
		sel.onchange = () => (this.draft.area = sel.value);

		const asBox = row.createDiv({ cls: 'lembro-field lembro-grow' });
		asBox.createEl('label', { text: 'Assunto' });
		const listId = `lembro-assuntos-${Date.now()}`;
		const as = asBox.createEl('input', { type: 'text', value: this.draft.assunto, attr: { list: listId, placeholder: 'Assunto > subassunto; outro' } });
		const dl = asBox.createEl('datalist', { attr: { id: listId } });
		for (const a of this.assuntos) dl.createEl('option', { value: a });
		as.oninput = () => (this.draft.assunto = as.value);

		const fonteBox = contentEl.createDiv({ cls: 'lembro-field' });
		fonteBox.createEl('label', { text: 'Fonte' });
		const fonte = fonteBox.createEl('input', { type: 'text', value: this.draft.fonte });
		fonte.oninput = () => (this.draft.fonte = fonte.value);

		contentEl.createEl('label', { text: 'Prévia', cls: 'lembro-label' });
		this.preview = contentEl.createDiv({ cls: 'lembro-preview' });
		void this.renderPreview();

		const buttons = contentEl.createDiv({ cls: 'lembro-buttons' });
		buttons.createEl('button', { text: 'Cancelar' }).onclick = () => this.close();
		const save = buttons.createEl('button', { text: 'Salvar (Ctrl+Enter)', cls: 'mod-cta' });
		save.onclick = () => void this.save();

		contentEl.createDiv({ cls: 'lembro-tip', text: 'Uma coisa por cartão. A pergunta tem uma resposta certa.' });

		this.scope.register(['Mod'], 'Enter', (e) => {
			e.preventDefault();
			void this.save();
			return false;
		});
		TIPOS.forEach((t, i) =>
			this.scope.register(['Mod'], String(i + 1), (e) => {
				e.preventDefault();
				this.setTipo(t);
				return false;
			}),
		);
		window.setTimeout(() => (this.focusBack ? back : front).focus(), 30);
	}

	private area(parent: HTMLElement, label: string, value: string, placeholder: string, set: (v: string) => void): HTMLTextAreaElement {
		const box = parent.createDiv({ cls: 'lembro-field' });
		box.createEl('label', { text: label });
		const ta = box.createEl('textarea', { attr: { rows: '3', placeholder } });
		ta.value = value;
		ta.oninput = () => {
			set(ta.value);
			void this.renderPreview();
		};
		return ta;
	}

	private setTipo(t: Tipo): void {
		this.draft.tipo = t;
		this.markTipo();
	}

	private markTipo(): void {
		this.chips.forEach((b) => b.toggleClass('is-on', b.textContent === this.draft.tipo));
	}

	private async renderPreview(): Promise<void> {
		if (!this.preview) return;
		this.preview.empty();
		const f = this.preview.createDiv({ cls: 'lembro-preview-front' });
		const b = this.preview.createDiv({ cls: 'lembro-preview-back' });
		await MarkdownRenderer.render(this.app, this.draft.frente || '…', f, this.draft.sourcePath, this.component);
		await MarkdownRenderer.render(this.app, this.draft.verso || '…', b, this.draft.sourcePath, this.component);
	}

	private async save(): Promise<void> {
		const r = resolveOnSave({ tipo: this.draft.tipo, frente: this.draft.frente, verso: this.draft.verso, context: this.draft.context });
		if ('error' in r) {
			new Notice(r.error);
			return;
		}
		const assuntos = this.draft.assunto
			.split(';')
			.map(normalizeAssunto)
			.filter(Boolean);
		try {
			await this.onSave({ ...r, area: this.draft.area, assuntos, fonte: this.draft.fonte.trim() });
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
		tipo: card.tipo,
		frente: card.frente,
		verso: card.verso,
		area,
		assunto: card.assuntos.join('; '),
		fonte: card.fonte,
		context: '',
		sourcePath,
	};
}
