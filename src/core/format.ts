import type { Card } from './types';

/**
 * Card files: blocks separated by a line `---` (outside code fences), each with
 * labelled fields. A field runs until the next label at the start of a line.
 *
 *   Front: How do I undo the last rollout?
 *   Back: `kubectl rollout undo deployment/web`
 *   Type: Question
 *   Topic: Kubernetes > Workloads
 *   Source: [[note|CKA study plan]] ^lk7q2a
 */
type Label = 'Front' | 'Back' | 'Type' | 'Topic' | 'Tags' | 'Reverse' | 'Source';
const LABELS = 'Front|Back|Type|Topic|Tags|Reverse|Source';
const LABEL_RE = new RegExp(`^(${LABELS}):[ \\t]?(.*)$`);
const BARE_LABEL_RE = new RegExp(`^(${LABELS}):[ \\t]?$`, 'i');
const ID_RE = /\s\^(l[a-z0-9]{5})\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;
// inline code is matched first and skipped, so `a == b == c` is never a highlight
const CLOZE_RE = /`[^`\n]*`|==([^=\n]+?)==/g;

export interface Block {
	start: number;
	end: number;
	lines: string[];
}

/** Splits a card file into blocks, ignoring `---` inside code fences. */
export function splitBlocks(text: string): Block[] {
	const lines = text.split('\n');
	const blocks: Block[] = [];
	let fence = false;
	let start = 0;
	const push = (end: number) => {
		const chunk = lines.slice(start, end + 1);
		if (chunk.some((l) => l.trim() !== '')) blocks.push({ start, end, lines: chunk });
	};
	lines.forEach((line, i) => {
		if (FENCE_RE.test(line)) fence = !fence;
		if (!fence && line.trim() === '---') {
			push(i - 1);
			start = i + 1;
		}
	});
	push(lines.length - 1);
	return blocks;
}

export function clozes(text: string): string[] {
	return [...text.matchAll(CLOZE_RE)].filter((m) => m[1] !== undefined).map((m) => (m[1] as string).trim());
}

/** The front with highlight `i` hidden as `___` and the others shown as plain text. */
export function hideCloze(text: string, i: number): string {
	let n = 0;
	return text.replace(CLOZE_RE, (m: string, inner: string | undefined) => (inner === undefined ? m : n++ === i ? '___' : inner));
}

/** `a >b>  c` becomes `a > b > c`. */
export function normalizeTopic(value: string): string {
	return value
		.split('>')
		.map((p) => p.trim())
		.filter(Boolean)
		.join(' > ');
}

const trimBlock = (value: string) => value.replace(/^\n+/, '').replace(/\s+$/, '');

/** Reads one block; returns null when it has no front or no back. */
export function parseBlock(block: Block): Card | null {
	const fields: Partial<Record<Label, string[]>> = {};
	let current: Label | null = null;
	let fence = false;
	let id: string | null = null;
	for (const raw of block.lines) {
		let line = raw;
		const idMatch = !fence ? ID_RE.exec(line) : null;
		if (idMatch) {
			id = idMatch[1] ?? null;
			line = line.replace(ID_RE, '');
		}
		const m = !fence ? LABEL_RE.exec(line) : null;
		if (m) {
			current = m[1] as Label;
			fields[current] = [m[2] ?? ''];
		} else if (current) {
			(fields[current] as string[]).push(line);
		}
		if (FENCE_RE.test(raw)) fence = !fence;
	}
	const get = (label: Label) => trimBlock((fields[label] ?? []).join('\n'));
	const front = get('Front');
	const back = get('Back');
	if (!front || (!back && !clozes(front).length)) return null;
	const tags = get('Tags')
		.split(/[\s,;]+/)
		.map((t) => t.replace(/^#/, '').trim().toLowerCase())
		.filter(Boolean);
	return {
		id,
		type: get('Type') || 'Question',
		front,
		back,
		topics: get('Topic')
			.split(';')
			.map(normalizeTopic)
			.filter(Boolean),
		...(tags.length ? { tags } : {}),
		...(/^(yes|true)$/i.test(get('Reverse')) ? { reverse: true } : {}),
		source: get('Source'),
		start: block.start,
		end: block.end,
	};
}

export function parseCardFile(text: string): Card[] {
	return splitBlocks(text)
		.map(parseBlock)
		.filter((c): c is Card => c !== null);
}

/**
 * A line that reads like a label (`Source: Wikipedia` in the middle of a back)
 * would start a new field on the next read: one leading space keeps it inside.
 * A `---` line would split the card in two: it becomes `- - -`, the same rule in markdown.
 */
function escapeLabels(lines: string[]): string[] {
	let fence = false;
	return lines.map((line) => {
		const inside = fence;
		if (FENCE_RE.test(line)) fence = !fence;
		if (inside) return line;
		if (line.trim() === '---') return '- - -';
		return LABEL_RE.test(line) ? ` ${line}` : line;
	});
}

const field = (label: Label, value: string) => (value.includes('\n') ? `${label}:\n${escapeLabels(value.split('\n')).join('\n')}` : `${label}: ${value}`);

export type CardFields = Pick<Card, 'id' | 'type' | 'front' | 'back' | 'topics' | 'source' | 'reverse' | 'tags'>;

/** Writes a card block (without the `---` separator). */
export function serializeCard(card: CardFields): string {
	const lines = [field('Front', card.front.trim()), field('Back', card.back.trim()), `Type: ${card.type}`];
	if (card.topics.length) lines.push(`Topic: ${card.topics.join('; ')}`);
	if (card.tags?.length) lines.push(`Tags: ${card.tags.map((t) => `#${t}`).join(' ')}`);
	if (card.reverse) lines.push('Reverse: yes');
	if (card.source) lines.push(`Source: ${card.source}`);
	if (card.id) lines[lines.length - 1] += ` ^${card.id}`;
	return lines.join('\n');
}

/** Appends a block to an existing card file text. */
export function appendCard(text: string, block: string): string {
	const base = text.replace(/\s+$/, '');
	return base ? `${base}\n\n---\n\n${block}\n` : `${block}\n`;
}

/** Replaces the block of `card` inside `text` with `block`, keeping the blank lines around it. */
export function replaceCard(text: string, card: Pick<Card, 'start' | 'end'>, block: string): string {
	const lines = text.split('\n');
	let s = card.start;
	let e = card.end;
	while (s < e && (lines[s] ?? '').trim() === '') s++;
	while (e > s && (lines[e] ?? '').trim() === '') e--;
	lines.splice(s, e - s + 1, ...block.split('\n'));
	return lines.join('\n');
}

/** End line (0-based) of a YAML frontmatter, or -1 when the file has none. */
function frontmatterEnd(lines: string[]): number {
	if ((lines[0] ?? '').trim() !== '---') return -1;
	for (let i = 1; i < lines.length; i++) if ((lines[i] ?? '').trim() === '---') return i;
	return -1;
}

/** Removes the block of `card` and one of its separators, keeping the frontmatter. */
export function removeCard(text: string, card: Pick<Card, 'start' | 'end'>): string {
	const lines = text.split('\n');
	const fmEnd = frontmatterEnd(lines);
	let s = card.start;
	let e = card.end;
	if (s > fmEnd + 1 && (lines[s - 1] ?? '').trim() === '---') s--;
	else if ((lines[e + 1] ?? '').trim() === '---') e++;
	lines.splice(s, e - s + 1);
	let lo = s;
	let hi = s;
	while (hi < lines.length && (lines[hi] ?? '').trim() === '') hi++;
	while (lo > 0 && (lines[lo - 1] ?? '').trim() === '') lo--;
	lines.splice(lo, hi - lo, ...(lo > 0 && hi < lines.length ? [''] : []));
	const out = lines.join('\n');
	return fmEnd < 0 ? out.replace(/^\s*---\s*\n/, '') : out;
}

export function newId(taken: Set<string>, random: () => number = Math.random): string {
	for (;;) {
		let id = 'l';
		for (let i = 0; i < 5; i++) id += Math.floor(random() * 36).toString(36);
		if (!taken.has(id)) {
			taken.add(id);
			return id;
		}
	}
}

/** Line that carries the block id: the last one outside a code fence, never a bare label. */
function idLineFor(lines: string[], start: number, end: number): number {
	let fence = false;
	const candidates: number[] = [];
	for (let i = start; i <= end; i++) {
		const line = lines[i] ?? '';
		const isFence = FENCE_RE.test(line);
		if (!fence && !isFence && line.trim() !== '') candidates.push(i);
		if (isFence) fence = !fence;
	}
	while (candidates.length) {
		const at = candidates[candidates.length - 1] as number;
		if (!BARE_LABEL_RE.test(lines[at] ?? '')) return at;
		candidates.pop();
	}
	return -1;
}

/** Gives an id to every card without one; returns the new text (or the same). */
export function ensureIds(text: string, taken: Set<string>, random?: () => number): { text: string; added: number } {
	const lines = text.split('\n');
	let added = 0;
	for (const block of splitBlocks(text)) {
		const card = parseBlock(block);
		if (!card || card.id) continue;
		const at = idLineFor(lines, block.start, block.end);
		if (at < 0) continue;
		lines[at] = `${(lines[at] as string).replace(/\s+$/, '')} ^${newId(taken, random)}`;
		added++;
	}
	return { text: added ? lines.join('\n') : text, added };
}

/** Characters a vault file name cannot carry (they break sync on mobile). */
const FORBIDDEN = /[:_"<>|?*\\/]/g;

/** File of a deck: the first topic becomes the path under the folder (`A > B` is `A/B.md`); no topic goes to `Inbox.md`. */
export function deckPath(topics: readonly string[], folder: string): string {
	const rel = (topics[0] ?? '')
		.split(' > ')
		.map((part) => part.replace(FORBIDDEN, '-').trim())
		.filter(Boolean)
		// `devices/` belongs to the per-device files and is never read as a deck
		.map((part, i) => (i === 0 && part.toLowerCase() === 'devices' ? 'Devices (deck)' : part))
		.join('/');
	return `${folder.replace(/\/+$/, '')}/${rel || 'Inbox'}.md`;
}

/**
 * The deck of a new card, with no question asked: the note's top-level folder
 * (`Bible/NT/Luke/Luke 1.md` is `Bible`), the note's name when it sits at the root,
 * and no deck (Inbox) when there is no note.
 */
export function deckFor(notePath: string | null): string {
	if (!notePath) return '';
	const parts = notePath.split('/');
	return (parts.length > 1 ? (parts[0] as string) : (parts[0] as string).replace(/\.[^.]+$/, '')).replace(/ > /g, ' - ').trim();
}

/** Vault path the link inside a `Source:` points to (without `#page` or alias). */
export function linkPath(source: string): string | null {
	const m = /\[\[([^\]|#]+)/.exec(source);
	return m ? (m[1] as string).trim() : null;
}

/** `[[path|name]]` for a note, `[[file.pdf#page=12|file, p. 12]]` for a PDF page. */
export function sourceLink(path: string | null, page: number | null = null): string {
	if (!path) return '';
	const name = (path.split('/').pop() ?? path).replace(/\.(md|pdf)$/, '');
	if (path.endsWith('.pdf')) return page ? `[[${path}#page=${page}|${name}, p. ${page}]]` : `[[${path}|${name}]]`;
	return `[[${path.replace(/\.md$/, '')}|${name}]]`;
}

const CLOZE_MAX_WORDS = 8;

/**
 * What a card becomes when saved: a front with `==highlights==` and no back is a
 * cloze; an empty front on a short selection turns into a cloze of its context;
 * an empty front on a long one is refused.
 */
export function resolveOnSave(o: { front: string; back: string; context: string }): { type: string; front: string; back: string } | { error: string; focus: 'front' | 'back' } {
	const front = o.front.trim();
	const back = o.back.trim();
	if (!back && clozes(front).length) return { type: 'Cloze', front, back: '' };
	if (!back) return { error: 'The back is empty.', focus: 'back' };
	if (front) return { type: clozes(front).length ? 'Cloze' : 'Question', front, back };
	const ctx = o.context.trim();
	if (back.split(/\s+/).length <= CLOZE_MAX_WORDS && ctx) return { type: 'Cloze', front: ctx.includes(back) ? ctx.replace(back, '[...]') : '[...]', back };
	return { error: 'Write the question: a cloze only covers a short excerpt (up to 8 words).', focus: 'front' };
}
