import { App, MarkdownView, TFile } from 'obsidian';

export interface CaptureContext {
	selection: string;
	/** the paragraph around the selection (for a cloze) */
	context: string;
	file: TFile | null;
	isPdf: boolean;
	page: number | null;
	cursorLine: number;
	noteText: string;
}

interface FileView {
	file?: TFile | null;
	getViewType(): string;
}

/** Selection and source of the active note or PDF. */
export async function captureContext(app: App): Promise<CaptureContext | null> {
	const md = app.workspace.getActiveViewOfType(MarkdownView);
	if (md) {
		const editor = md.editor;
		const selection = editor.getSelection();
		const from = editor.getCursor('from');
		const to = editor.getCursor('to');
		const lines: string[] = [];
		for (let i = from.line; i <= to.line; i++) lines.push(editor.getLine(i));
		return {
			selection,
			context: lines.join('\n'),
			file: md.file,
			isPdf: false,
			page: null,
			cursorLine: from.line,
			noteText: editor.getValue(),
		};
	}
	const view = app.workspace.getMostRecentLeaf()?.view as unknown as FileView | undefined;
	if (view && view.getViewType() === 'pdf') {
		const sel = activeWindow.getSelection();
		const selection = sel ? sel.toString().replace(/\s+\n/g, '\n').trim() : '';
		let page: number | null = null;
		const node = sel?.anchorNode;
		const el = node instanceof Element ? node : node?.parentElement;
		const pageEl = el?.closest('[data-page-number]');
		if (pageEl) page = Number(pageEl.getAttribute('data-page-number')) || null;
		return { selection, context: selection, file: view.file ?? null, isPdf: true, page, cursorLine: 0, noteText: '' };
	}
	return null;
}

/** `[[path|name]]`, or `[[file.pdf#page=12|file, p. 12]]`. */
export function sourceLink(file: TFile | null, page: number | null): string {
	if (!file) return '';
	if (file.extension === 'pdf') {
		return page ? `[[${file.path}#page=${page}|${file.basename}, p. ${page}]]` : `[[${file.path}|${file.basename}]]`;
	}
	return `[[${file.path.replace(/\.md$/, '')}|${file.basename}]]`;
}
