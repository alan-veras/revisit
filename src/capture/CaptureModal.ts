import { App, Component, FuzzySuggestModal, MarkdownRenderer, Modal, Notice } from 'obsidian';
import { normalizeTopic } from '../cards/format';
import { Card, CardType, CARD_TYPES, parseTags } from '../cards/types';
import { resolveOnSave } from './autoType';

export interface CaptureDraft {
	type: CardType;
	front: string;
	back: string;
	topic: string;
	source: string;
	/** paragraph around the selection, for a cloze */
	context: string;
	/** where the source note is, to resolve links in the preview */
	sourcePath: string;
	reverse?: boolean;
	tags?: string[];
}

export interface CaptureResult {
	type: CardType;
	front: string;
	back: string;
	topics: string[];
	tags: string[];
	source: string;
	reverse: boolean;
}

/** The capture window: one front, one back and an optional topic. */
export class CaptureModal extends Modal {
	private draft: CaptureDraft;
	private preview: HTMLElement | null = null;
	private component = new Component();
	private chips: HTMLButtonElement[] = [];
	private frontEl: HTMLTextAreaElement | null = null;
	private backEl: HTMLTextAreaElement | null = null;
	private tagsRaw = '';

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
		this.tagsRaw = (draft.tags ?? []).join(' ');
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass('revisit-capture');
		this.component.load();
		contentEl.createEl('h3', { text: this.title });

		const chips = contentEl.createDiv({ cls: 'revisit-chips' });
		CARD_TYPES.forEach((t, i) => {
			const b = chips.createEl('button', { text: t, attr: { title: `Ctrl+${i + 1}` } });
			b.onclick = () => this.setType(t);
			this.chips.push(b);
		});
		this.markType();

		this.frontEl = this.box(contentEl, 'Front', this.draft.front, 'The question', (v) => (this.draft.front = v));
		this.backEl = this.box(contentEl, 'Back', this.draft.back, 'The answer', (v) => (this.draft.back = v));

		const row = contentEl.createDiv({ cls: 'revisit-row' });
		const topicBox = row.createDiv({ cls: 'revisit-field revisit-grow' });
		topicBox.createEl('label', { text: 'Topic' });
		const listId = `revisit-topics-${Date.now()}`;
		const topicInput = topicBox.createEl('input', { type: 'text', value: this.draft.topic, attr: { list: listId, placeholder: 'Topic > subtopic; another (empty goes to no deck)' } });
		const dl = topicBox.createEl('datalist', { attr: { id: listId } });
		for (const a of this.topics) dl.createEl('option', { value: a });
		topicInput.oninput = () => (this.draft.topic = topicInput.value);
		const pick = topicBox.createEl('button', { text: 'Pick deck', cls: 'revisit-pick', attr: { 'aria-label': 'Pick a deck from the ones that exist' } });
		pick.onclick = () => {
			new DeckSuggest(this.app, this.topics, (t) => {
				topicInput.value = t;
				this.draft.topic = t;
				topicInput.focus();
			}).open();
		};

		const sourceBox = contentEl.createDiv({ cls: 'revisit-field' });
		sourceBox.createEl('label', { text: 'Source' });
		const source = sourceBox.createEl('input', { type: 'text', value: this.draft.source });
		source.oninput = () => (this.draft.source = source.value);

		const tagsBox = contentEl.createDiv({ cls: 'revisit-field' });
		tagsBox.createEl('label', { text: 'Tags' });
		const tags = tagsBox.createEl('input', { type: 'text', value: this.tagsRaw, attr: { placeholder: 'Space separated; #important comes back more often' } });
		tags.oninput = () => (this.tagsRaw = tags.value);

		const rev = contentEl.createEl('label', { cls: 'revisit-check' });
		const cb = rev.createEl('input', { type: 'checkbox' });
		cb.checked = !!this.draft.reverse;
		cb.onchange = () => (this.draft.reverse = cb.checked);
		rev.appendText(' Review both ways (the back becomes a question too)');

		contentEl.createEl('label', { text: 'Preview', cls: 'revisit-label' });
		this.preview = contentEl.createDiv({ cls: 'revisit-preview' });
		void this.renderPreview();

		const buttons = contentEl.createDiv({ cls: 'revisit-buttons' });
		buttons.createEl('button', { text: 'Cancel' }).onclick = () => this.close();
		const save = buttons.createEl('button', { text: 'Save (Ctrl+Enter)', cls: 'mod-cta' });
		save.onclick = () => void this.save();

		contentEl.createDiv({ cls: 'revisit-tip', text: 'One thing per card. The question has one right answer.' });

		this.scope.register(['Mod'], 'Enter', (e) => {
			e.preventDefault();
			void this.save();
			return false;
		});
		CARD_TYPES.forEach((t, i) =>
			this.scope.register(['Mod'], String(i + 1), (e) => {
				e.preventDefault();
				this.setType(t);
				return false;
			}),
		);
		window.setTimeout(() => (this.focusBack ? this.backEl : this.frontEl)?.focus(), 30);
	}

	private box(parent: HTMLElement, label: string, value: string, placeholder: string, set: (v: string) => void): HTMLTextAreaElement {
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

	private setType(t: CardType): void {
		this.draft.type = t;
		this.markType();
	}

	private markType(): void {
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
			(r.focus === 'front' ? this.frontEl : this.backEl)?.focus();
			return;
		}
		const topics = this.draft.topic
			.split(';')
			.map(normalizeTopic)
			.filter(Boolean);
		try {
			await this.onSave({ ...r, topics, tags: parseTags(this.tagsRaw), source: this.draft.source.trim(), reverse: !!this.draft.reverse });
			this.close();
		} catch (e) {
			new Notice(`Revisit: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.component.unload();
		this.contentEl.empty();
	}
}

export function draftFromCard(card: Card, sourcePath: string): CaptureDraft {
	return {
		type: card.type,
		front: card.front,
		back: card.back,
		topic: card.topics.join('; '),
		source: card.source,
		context: '',
		sourcePath,
		reverse: !!card.reverse,
		...(card.tags?.length ? { tags: card.tags } : {}),
	};
}

/** Lists the decks that already exist; typing filters, choosing fills the topic field. */
class DeckSuggest extends FuzzySuggestModal<string> {
	constructor(
		app: App,
		private decks: string[],
		private pick: (deck: string) => void,
	) {
		super(app);
		this.setPlaceholder('Pick a deck');
	}
	getItems(): string[] {
		return this.decks;
	}
	getItemText(deck: string): string {
		return deck;
	}
	onChooseItem(deck: string): void {
		this.pick(deck);
	}
}
