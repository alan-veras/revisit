import { clozes } from './cloze';
import { Card, isCardType, parseTags, CardType } from './types';

/**
 * Card files: blocks separated by a line `---` (outside code fences), each with
 * labelled fields. A field runs until the next label at the start of a line.
 *
 *   Frente: Como desfazer o último rollout?
 *   Verso:
 *   `kubectl rollout undo deployment/web`
 *   Tipo: Pergunta
 *   Assunto: Kubernetes > Workloads
 *   Fonte: [[...|Cronograma do CKA]] ^lk7q2a
 */

type Label = 'Frente' | 'Verso' | 'Tipo' | 'Área' | 'Assunto' | 'Tags' | 'Reverso' | 'Fonte';
const LABEL_RE = /^(Frente|Verso|Tipo|Área|Assunto|Tags|Reverso|Fonte):[ \t]?(.*)$/;
const ID_RE = /\s\^(l[a-z0-9]{5})\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

interface Block {
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

function trimBlock(value: string): string {
	return value.replace(/^\n+/, '').replace(/\s+$/, '');
}

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
	const front = get('Frente');
	const back = get('Verso');
	if (!front || (!back && !clozes(front).length)) return null;
	const typeRaw = get('Tipo');
	const type: CardType = isCardType(typeRaw) ? typeRaw : 'Pergunta';
	const topics = get('Assunto')
		.split(';')
		.map((a) => normalizeTopic(a))
		.filter(Boolean);
	const tags = parseTags(get('Tags'));
	const area = get('Área');
	const reverse = /^(sim|s|yes|true)$/i.test(get('Reverso'));
	return {
		id,
		type,
		front,
		back,
		...(area ? { area } : {}),
		topics,
		...(tags.length ? { tags } : {}),
		...(reverse ? { reverse } : {}),
		source: get('Fonte'),
		start: block.start,
		end: block.end,
	};
}

export function parseCardFile(text: string): Card[] {
	return splitBlocks(text)
		.map(parseBlock)
		.filter((c): c is Card => c !== null);
}

/** `a >b>  c` becomes `a > b > c`. */
export function normalizeTopic(value: string): string {
	return value
		.split('>')
		.map((p) => p.trim())
		.filter(Boolean)
		.join(' > ');
}

function field(label: Label, value: string): string {
	return value.includes('\n') ? `${label}:\n${value}` : `${label}: ${value}`;
}

/** Writes a card block (without the `---` separator). */
export type CardFields = Pick<Card, 'id' | 'type' | 'front' | 'back' | 'topics' | 'source' | 'area' | 'reverse' | 'tags'>;

export function serializeCard(card: CardFields): string {
	const lines = [field('Frente', card.front.trim()), field('Verso', card.back.trim()), `Tipo: ${card.type}`];
	if (card.area) lines.push(`Área: ${card.area}`);
	if (card.topics.length) lines.push(`Assunto: ${card.topics.join('; ')}`);
	if (card.tags?.length) lines.push(`Tags: ${card.tags.map((t) => `#${t}`).join(' ')}`);
	if (card.reverse) lines.push('Reverso: sim');
	if (card.source) lines.push(`Fonte: ${card.source}`);
	if (card.id) {
		const last = lines.length - 1;
		lines[last] = `${lines[last] as string} ^${card.id}`;
	}
	return lines.join('\n');
}

/** Appends a card to an existing card file text. */
export function appendCard(text: string, block: string): string {
	const base = text.replace(/\s+$/, '');
	return base ? `${base}\n\n---\n\n${block}\n` : `${block}\n`;
}

/** Appends several blocks at once, in order: one write for a whole batch. */
export function appendCards(text: string, blocks: string[]): string {
	return blocks.reduce((t, b) => appendCard(t, b), text);
}

/** Groups items by destination, keeping the first-seen order of destinations and of items. */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
	const out = new Map<string, T[]>();
	for (const it of items) {
		const k = key(it);
		const g = out.get(k);
		if (g) g.push(it);
		else out.set(k, [it]);
	}
	return out;
}

/** Replaces the block of `card` inside `text` with `block`. */
export function replaceCard(text: string, card: Pick<Card, 'start' | 'end'>, block: string): string {
	const lines = text.split('\n');
	// keep the blank lines around the block
	let s = card.start;
	let e = card.end;
	while (s < e && (lines[s] ?? '').trim() === '') s++;
	while (e > s && (lines[e] ?? '').trim() === '') e--;
	lines.splice(s, e - s + 1, ...block.split('\n'));
	return lines.join('\n');
}

/** End line (0-based) of a YAML frontmatter, or -1 when the file has none. */
export function frontmatterEnd(lines: string[]): number {
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
	// the separator above the first card is the frontmatter closer when there is one
	if (s > fmEnd + 1 && (lines[s - 1] ?? '').trim() === '---') s--;
	else if ((lines[e + 1] ?? '').trim() === '---') e++;
	lines.splice(s, e - s + 1);
	let lo = s;
	let hi = s;
	while (hi < lines.length && (lines[hi] ?? '').trim() === '') hi++;
	while (lo > 0 && (lines[lo - 1] ?? '').trim() === '') lo--;
	// one blank line between the neighbors at the seam, none at the file edges
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

/**
 * Line of the block that carries the block id: the last one outside a code
 * fence, never a bare label (`Verso:` alone would lose its field when the id
 * is stripped on the next read), so a card whose back is only a code block
 * gets the id on an earlier line.
 */
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
		if (!/^(Frente|Verso|Tipo|Área|Assunto|Tags|Reverso|Fonte):[ \t]?$/i.test(lines[at] ?? '')) return at;
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

/**
 * Rewrites `Fonte:` links that point to `from` (a vault path, with or without
 * `.md`) so they point to `to`, keeping `#page=`, headings and aliases.
 */
export function renameSource(text: string, from: string, to: string): string {
	const strip = (p: string) => p.replace(/\.md$/, '');
	const a = strip(from);
	const b = strip(to);
	return text
		.split('\n')
		.map((line) => {
			if (!line.startsWith('Fonte:')) return line;
			return line.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/g, (m, target: string, rest: string) =>
				strip(target) === a ? `[[${b}${rest}]]` : m,
			);
		})
		.join('\n');
}

/** Same for a renamed folder: every target inside `fromFolder` moves to `toFolder`. */
export function renameSourceFolder(text: string, fromFolder: string, toFolder: string): string {
	const a = fromFolder.replace(/\/+$/, '').replace(/\.md$/, '');
	const b = toFolder.replace(/\/+$/, '').replace(/\.md$/, '');
	return text
		.split('\n')
		.map((line) => {
			if (!line.startsWith('Fonte:')) return line;
			return line.replace(/\[\[([^\]|#]+)([^\]]*)\]\]/g, (m, target: string, rest: string) => {
				const t = target.replace(/\.md$/, '');
				return t === a || t.startsWith(a + '/') ? `[[${b}${t.slice(a.length)}${rest}]]` : m;
			});
		})
		.join('\n');
}

/** Assuntos as shown on screen: only the last level (`Sustento > Perseguição` reads `Perseguição`). */
export function topicsLabel(topics: string[]): string {
	return topics.map((a) => a.split(' > ').pop() ?? a).join('; ');
}
