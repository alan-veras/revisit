import { CliFlags, normalizePath, TFile } from 'obsidian';
import { clozes } from '../cards/cloze';
import { groupBy, normalizeTopic } from '../cards/format';
import { linkPath } from '../cards/link';
import { mirrorPath } from '../cards/mirror';
import { Card, CARD_TYPES, isCardType } from '../cards/types';
import type RevisitPlugin from '../main';
import { forecast } from '../srs/budget';
import { estimateMinutes, matchesFilter } from '../srs/queue';
import { cardRow } from '../srs/rows';
import { cardStats } from '../srs/stats';
import { CliError, flag, json, need, Params, parseBatch, short, unescape } from './args';

/**
 * `revisit:` commands of the Obsidian CLI, for agents. They read and write cards;
 * none of them grades a card: grading is the owner's.
 */

interface Command {
	desc: string;
	flags: Record<string, string>;
	run: (p: Params, plugin: RevisitPlugin) => Promise<string>;
}

const BOOL_FLAGS = ['dry', 'reactivate', 'reverse'];

/** The `folder` flag: a folder or a note, as a vault path. */
function scope(p: Params): string | null {
	return p.folder?.trim().replace(/\/+$/, '') || null;
}

function findCard(plugin: RevisitPlugin, id: string): Card {
	const c = plugin.store.cards.find((x) => x.id === id.replace(/^\^/, ''));
	if (!c) throw new CliError('id', `card not found: ${id}`);
	return c;
}

function topicsOf(p: Params): string[] {
	return (p.topic ?? '').split(';').map(normalizeTopic).filter(Boolean);
}

/** Card file for a source link (or none). */
function placeFor(plugin: RevisitPlugin, source: string): string {
	const link = linkPath(source);
	const file = link ? plugin.app.metadataCache.getFirstLinkpathDest(link, '') : null;
	const src = file?.path ?? (link || null);
	// a source that is itself a card file would be mirrored inside the mirror (Revisit/x/Revisit/x.md)
	const folder = normalizePath(plugin.settings.folder);
	if (src && (src === folder || src.startsWith(folder + '/')))
		throw new CliError('source', `the source ${source} points to a Revisit card file (${src}); use the source note`);
	return mirrorPath(src, plugin.settings.folder);
}

function typeOf(value: string): Card['type'] {
	if (!isCardType(value)) throw new CliError('parameter', `invalid type: ${value} (use ${CARD_TYPES.join(', ')})`);
	return value;
}

const FOLDER_FLAG = 'Folder or note, as a vault path';

const COMMANDS: Record<string, Command> = {
	today: {
		desc: 'How many cards fit today, estimated minutes and the next 7 days',
		flags: { folder: FOLDER_FLAG },
		run: async (p, plugin) => {
			const a = scope(p);
			const s = plugin.session(a);
			const items = plugin.items().filter((it) => matchesFilter(it, a));
			return json({
				folder: a ?? 'All',
				fit: s.length,
				minutes: estimateMinutes(s, plugin.secs()),
				budget: plugin.settings.budgetMinutes,
				next7: forecast(items, plugin.secs(), new Date()),
				new: plugin.quota(),
			});
		},
	},
	cards: {
		desc: 'Lists the cards: id, short front, topic, state, next date, correct and wrong',
		flags: { folder: FOLDER_FLAG, topic: 'Topic prefix', note: 'Part of the source path', status: 'new, learning, review, suspended', search: 'Text on the front or the back', limit: 'Maximum rows (50)' },
		run: async (p, plugin) => {
			const a = scope(p);
			const stats = cardStats(plugin.store.log);
			const note = p.note?.toLowerCase();
			const search = p.search?.toLowerCase();
			const status = p.status?.toLowerCase();
			const rows = plugin
				.items()
				.filter((it) => matchesFilter(it, a, p.topic))
				.filter((it) => !note || (it.source ?? '').toLowerCase().includes(note))
				.filter((it) => !search || `${it.card.front}\n${it.card.back}`.toLowerCase().includes(search))
				.map((it) => cardRow(it, stats, new Date()))
				.filter((r) => !status || r.status === status)
				.slice(0, Number(p.limit) || 50)
				.map((r) => ({
					id: r.id,
					side: r.side,
					front: short(r.front),
					type: r.type,
					topics: r.topics,
					source: r.source,
					status: r.status,
					next: r.due ? r.due.toISOString().slice(0, 10) : null,
					correct: r.ok,
					wrong: r.bad,
				}));
			return json(rows);
		},
	},
	show: {
		desc: 'Shows one whole card by id',
		flags: { id: 'Card id (lxxxxx)' },
		run: async (p, plugin) => {
			const c = findCard(plugin, need(p, 'id'));
			return json({ id: c.id, type: c.type, front: c.front, back: c.back, topics: c.topics, source: c.source, file: c.file });
		},
	},
	new: {
		desc: 'Creates a card in the mirror file of the source',
		flags: { front: 'Front (\\n breaks the line)', back: 'Back (empty is fine when the front has ==cloze==)', source: 'Source [[...]] link', topic: 'Topic; another', type: CARD_TYPES.join(', '), reverse: 'Review back to front too', dry: 'Shows only, writes nothing' },
		run: async (p, plugin) => {
			const type = typeOf(p.type ?? 'Question');
			const source = p.source ?? '';
			const path = placeFor(plugin, source);
			const front = unescape(need(p, 'front'));
			const back = p.back && p.back !== 'true' ? unescape(p.back) : '';
			if (!back && !clozes(front).length) throw new CliError('parameter', 'missing back= (or mark the cloze with ==like this== on the front)');
			const card = {
				id: null,
				type,
				front,
				back,
				topics: topicsOf(p),
				...(flag(p, 'reverse') ? { reverse: true } : {}),
				source,
			};
			if (flag(p, 'dry')) return json({ dry: true, file: path, card });
			const id = await plugin.store.addCard(path, card);
			await plugin.reload();
			return json({ ok: true, id, file: path });
		},
	},
	batch: {
		desc: 'Creates several cards from a markdown in the card format (blocks separated by ---)',
		flags: { file: 'Vault path of the markdown with the cards', source: 'Source for the cards without a Source:', topic: 'Topic for the cards without a Topic:', dry: 'Shows only, writes nothing' },
		run: async (p, plugin) => {
			const path = normalizePath(need(p, 'file'));
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new CliError('file', `file not found: ${path}`);
			const cards = parseBatch(await plugin.app.vault.cachedRead(file)).map((c) => ({
				...c,
				source: c.source || (p.source ?? ''),
				topics: c.topics.length ? c.topics : topicsOf(p),
			}));
			const dests = cards.map((c) => placeFor(plugin, c.source));
			if (flag(p, 'dry')) return json({ dry: true, cards: cards.length, files: [...new Set(dests)], preview: cards.slice(0, 5).map((c) => ({ front: short(c.front), type: c.type, topics: c.topics })) });
			// one write per destination file, then check that every card landed; retry the missing once
			const items = cards.map((card, i) => ({ card, dest: dests[i] as string }));
			const written: typeof items = [];
			for (const [dest, group] of groupBy(items, (it) => it.dest)) {
				const ids = await plugin.store.addCards(dest, group.map((it) => it.card));
				group.forEach((it, i) => written.push({ dest, card: { ...it.card, id: ids[i] as string } }));
			}
			await plugin.reload();
			const present = () => new Set(plugin.store.cards.map((c) => c.id));
			let missing = written.filter((it) => !present().has(it.card.id));
			if (missing.length) {
				for (const [dest, group] of groupBy(missing, (it) => it.dest)) await plugin.store.addCards(dest, group.map((it) => it.card));
				await plugin.reload();
				missing = written.filter((it) => !present().has(it.card.id));
			}
			const ids = written.map((it) => it.card.id as string);
			if (missing.length) return json({ ok: false, created: ids.length - missing.length, missing: missing.map((it) => ({ id: it.card.id, front: short(it.card.front), file: it.dest })) });
			return json({ ok: true, created: ids.length, ids });
		},
	},
	edit: {
		desc: 'Edits one card by id (only the passed fields)',
		flags: { id: 'Card id (lxxxxx)', front: 'New front', back: 'New back', topic: 'New topics', type: 'New type', dry: 'Shows only, writes nothing' },
		run: async (p, plugin) => {
			const c = findCard(plugin, need(p, 'id'));
			const { start: _s, end: _e, file: _f, ...rest } = c;
			const next = {
				...rest,
				type: typeOf(p.type ?? c.type),
				front: p.front ? unescape(p.front) : c.front,
				back: p.back ? unescape(p.back) : c.back,
				topics: p.topic ? topicsOf(p) : c.topics,
			};
			if (flag(p, 'dry')) return json({ dry: true, card: next });
			await plugin.store.updateCard(c, next);
			await plugin.reload();
			return json({ ok: true, id: c.id });
		},
	},
	suspend: {
		desc: 'Suspends a card (reactivate=1 undoes it)',
		flags: { id: 'Card id', reactivate: 'Unsuspends instead of suspending', dry: 'Shows only, writes nothing' },
		run: async (p, plugin) => {
			const id = findCard(plugin, need(p, 'id')).id as string;
			const st = flag(p, 'reactivate') ? 'active' : 'suspended';
			if (flag(p, 'dry')) return json({ dry: true, id, status: st });
			plugin.store.state[id] = { ...(plugin.store.state[id] ?? {}), st };
			await plugin.store.saveState();
			plugin.updateStatus();
			return json({ ok: true, id, status: st });
		},
	},
	review: {
		desc: 'Opens the Revisit session of a folder or note, with a minute limit',
		flags: { folder: FOLDER_FLAG, minutes: 'Session limit' },
		run: async (p, plugin) => {
			const minutes = p.minutes ? Number(p.minutes) : undefined;
			if (minutes !== undefined && !(minutes > 0)) throw new CliError('parameter', `invalid minutes: ${p.minutes}`);
			const a = scope(p);
			await plugin.review(a, minutes);
			return json({ ok: true, fit: plugin.session(a, minutes).length });
		},
	},
};

export async function runCli(plugin: RevisitPlugin, cmd: Command, params: Params): Promise<string> {
	try {
		await plugin.reload();
		return await cmd.run({ ...params }, plugin);
	} catch (e) {
		if (e instanceof CliError) return json({ error: e.code, message: e.message });
		return json({ error: 'internal', message: e instanceof Error ? e.message : String(e) });
	}
}

/** Registers every command as `revisit:<name>`. */
export function registerCli(plugin: RevisitPlugin): void {
	const register = (name: string, cmd: Command): void => {
		const flags: CliFlags = Object.fromEntries(
			Object.entries(cmd.flags).map(([k, description]) => [k, BOOL_FLAGS.includes(k) ? { description } : { value: `<${k}>`, description }]),
		);
		plugin.registerCliHandler(`revisit:${name}`, cmd.desc, Object.keys(flags).length ? flags : null, (params) => runCli(plugin, cmd, params));
	};
	for (const [name, cmd] of Object.entries(COMMANDS)) register(name, cmd);
}
