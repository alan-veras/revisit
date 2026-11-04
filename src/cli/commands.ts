import { CliFlags, normalizePath, TFile } from 'obsidian';
import { areaOf, linkPath } from '../cards/area';
import { clozes } from '../cards/cloze';
import { groupBy, normalizeTopic } from '../cards/format';
import { mirrorPath } from '../cards/mirror';
import { AREAS, Card, isCardType } from '../cards/types';
import type RevisitPlugin from '../main';
import { forecast } from '../srs/budget';
import { estimateMinutes, matchesFilter } from '../srs/queue';
import { CardStatus, cardRow } from '../srs/rows';
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

const BOOL_FLAGS = ['dry', 'reativar', 'reverso'];

/** The `estado` flag keeps its old Portuguese values working beside the new English ones. */
const STATUS_ALIASES: Record<string, CardStatus> = { novo: 'new', aprendendo: 'learning', revisao: 'review', suspenso: 'suspended' };

function statusFilter(p: Params): string | undefined {
	const v = p.estado?.toLowerCase();
	if (!v) return undefined;
	return STATUS_ALIASES[v] ?? v;
}

function area(p: Params): string | null {
	const a = p.area?.trim();
	if (!a) return null;
	const hit = AREAS.find((x) => x.toLowerCase() === a.toLowerCase());
	if (!hit) throw new CliError('parametro', `área desconhecida: ${a} (use ${AREAS.join(', ')})`);
	return hit;
}

function findCard(plugin: RevisitPlugin, id: string): Card {
	const c = plugin.store.cards.find((x) => x.id === id.replace(/^\^/, ''));
	if (!c) throw new CliError('id', `cartão não encontrado: ${id}`);
	return c;
}

function topicsOf(p: Params): string[] {
	return (p.assunto ?? '').split(';').map(normalizeTopic).filter(Boolean);
}

/** Card file and derived área for a source link (or none). */
function placeFor(plugin: RevisitPlugin, source: string): { path: string; derived: string | null } {
	const link = linkPath(source);
	const file = link ? plugin.app.metadataCache.getFirstLinkpathDest(link, '') : null;
	const src = file?.path ?? (link || null);
	// a source that is itself a card file would be mirrored inside the mirror (Lembro/x/Lembro/x.md)
	const folder = normalizePath(plugin.settings.folder);
	if (src && (src === folder || src.startsWith(folder + '/')))
		throw new CliError('fonte', `a fonte ${source} aponta para um arquivo de cartões do Lembro (${src}); use a nota de origem`);
	return { path: mirrorPath(src, plugin.settings.folder), derived: src ? areaOf(src, plugin.settings.areaMap) : null };
}

function typeOf(value: string): Card['type'] {
	if (!isCardType(value)) throw new CliError('parametro', `tipo inválido: ${value} (use Pergunta, Lacuna, Referência, Questão)`);
	return value;
}

const COMMANDS: Record<string, Command> = {
	hoje: {
		desc: 'Quantos cartões cabem hoje, minutos previstos e os próximos 7 dias',
		flags: { area: 'Uma das 5 Dedicações' },
		run: async (p, plugin) => {
			const a = area(p);
			const s = plugin.session(a);
			const items = plugin.items().filter((it) => matchesFilter(it, a));
			return json({
				area: a ?? 'Tudo',
				fit: s.length,
				minutes: estimateMinutes(s, plugin.secs()),
				budget: plugin.settings.budgetMinutes,
				next7: forecast(items, plugin.secs(), new Date()),
				new: (() => {
					const q = plugin.quota();
					return { total: q.total, reduced: q.reduced, areas: Object.fromEntries(q.areas.map((x) => [x.area, { used: x.used, cap: x.cap, quota: x.quota }])) };
				})(),
			});
		},
	},
	cartoes: {
		desc: 'Lista os cartões: id, frente curta, assunto, estado, próxima data, acertos e erros',
		flags: { area: 'Dedicação', assunto: 'Prefixo do assunto', nota: 'Parte do caminho da fonte', estado: 'novo, aprendendo, revisao, suspenso', busca: 'Texto na frente ou no verso', limite: 'Máximo de linhas (50)' },
		run: async (p, plugin) => {
			const a = area(p);
			const stats = cardStats(plugin.store.log);
			const nota = p.nota?.toLowerCase();
			const busca = p.busca?.toLowerCase();
			const status = statusFilter(p);
			const rows = plugin
				.items()
				.filter((it) => matchesFilter(it, a, p.assunto))
				.filter((it) => !nota || (plugin.resolveSource(it.card) ?? '').toLowerCase().includes(nota))
				.filter((it) => !busca || `${it.card.front}\n${it.card.back}`.toLowerCase().includes(busca))
				.map((it) => cardRow(it, stats, new Date()))
				.filter((r) => !status || r.status === status)
				.slice(0, Number(p.limite) || 50)
				.map((r) => ({
					id: r.id,
					side: r.side,
					front: short(r.front),
					type: r.type,
					area: r.area,
					topics: r.topics,
					source: plugin.resolveSource(r.item.card),
					status: r.status,
					next: r.due ? r.due.toISOString().slice(0, 10) : null,
					correct: r.ok,
					wrong: r.bad,
				}));
			return json(rows);
		},
	},
	ver: {
		desc: 'Mostra um cartão inteiro pelo id',
		flags: { id: 'Id do cartão (lxxxxx)' },
		run: async (p, plugin) => {
			const c = findCard(plugin, need(p, 'id'));
			return json({ id: c.id, type: c.type, front: c.front, back: c.back, area: plugin.areaOfCard(c), topics: c.topics, source: c.source, file: c.file });
		},
	},
	novo: {
		desc: 'Cria um cartão no arquivo-espelho da fonte',
		flags: { frente: 'Frente (\\n quebra linha)', verso: 'Verso (vazio vale quando a frente tem ==lacuna==)', fonte: 'Link [[...]] da origem', assunto: 'Assunto; outro', tipo: 'Pergunta, Lacuna, Referência, Questão', area: 'Dedicação, se a fonte não disser', reverso: 'Revisar também do verso para a frente', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const type = typeOf(p.tipo ?? 'Pergunta');
			const source = p.fonte ?? '';
			const { path, derived } = placeFor(plugin, source);
			const a = area(p);
			const front = unescape(need(p, 'frente'));
			const back = p.verso && p.verso !== 'true' ? unescape(p.verso) : '';
			if (!back && !clozes(front).length) throw new CliError('parametro', 'falta verso= (ou marque a lacuna com ==assim== na frente)');
			const card = {
				id: null,
				type,
				front,
				back,
				...(a && a !== derived ? { area: a } : {}),
				topics: topicsOf(p),
				...(flag(p, 'reverso') ? { reverse: true } : {}),
				source,
			};
			if (flag(p, 'dry')) return json({ dry: true, file: path, area: a ?? derived, card });
			const id = await plugin.store.addCard(path, card);
			await plugin.reload();
			return json({ ok: true, id, file: path });
		},
	},
	lote: {
		desc: 'Cria vários cartões a partir de um markdown no formato do cartão (blocos separados por ---)',
		flags: { arquivo: 'Caminho no vault do markdown com os cartões', fonte: 'Fonte para os cartões sem Fonte:', assunto: 'Assunto para os cartões sem Assunto:', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const path = normalizePath(need(p, 'arquivo'));
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new CliError('arquivo', `arquivo não encontrado: ${path}`);
			const cards = parseBatch(await plugin.app.vault.cachedRead(file)).map((c) => ({
				...c,
				source: c.source || (p.fonte ?? ''),
				topics: c.topics.length ? c.topics : topicsOf(p),
			}));
			const dests = cards.map((c) => placeFor(plugin, c.source).path);
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
	editar: {
		desc: 'Edita um cartão pelo id (só os campos passados)',
		flags: { id: 'Id do cartão (lxxxxx)', frente: 'Nova frente', verso: 'Novo verso', assunto: 'Novos assuntos', tipo: 'Novo tipo', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const c = findCard(plugin, need(p, 'id'));
			const { start: _s, end: _e, file: _f, ...rest } = c;
			const next = {
				...rest,
				type: typeOf(p.tipo ?? c.type),
				front: p.frente ? unescape(p.frente) : c.front,
				back: p.verso ? unescape(p.verso) : c.back,
				topics: p.assunto ? topicsOf(p) : c.topics,
			};
			if (flag(p, 'dry')) return json({ dry: true, card: next });
			await plugin.store.updateCard(c, next);
			await plugin.reload();
			return json({ ok: true, id: c.id });
		},
	},
	suspender: {
		desc: 'Suspende um cartão (reativar=1 desfaz)',
		flags: { id: 'Id do cartão', reativar: 'Reativa em vez de suspender', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const id = findCard(plugin, need(p, 'id')).id as string;
			const st = flag(p, 'reativar') ? 'active' : 'suspended';
			if (flag(p, 'dry')) return json({ dry: true, id, status: st });
			plugin.store.state[id] = { ...(plugin.store.state[id] ?? {}), st };
			await plugin.store.saveState();
			plugin.updateStatus();
			return json({ ok: true, id, status: st });
		},
	},
	revisar: {
		desc: 'Abre a sessão do Lembro numa área, com limite de minutos',
		flags: { area: 'Dedicação', minutos: 'Limite da sessão' },
		run: async (p, plugin) => {
			const minutes = p.minutos ? Number(p.minutos) : undefined;
			if (minutes !== undefined && !(minutes > 0)) throw new CliError('parametro', `minutos inválido: ${p.minutos}`);
			const a = area(p);
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
		if (e instanceof CliError) return json({ erro: e.code, mensagem: e.message });
		return json({ erro: 'interno', mensagem: e instanceof Error ? e.message : String(e) });
	}
}

/** Registers every command as `revisit:<nome>` in the Obsidian CLI. */
export function registerCli(plugin: RevisitPlugin): void {
	for (const [name, cmd] of Object.entries(COMMANDS)) {
		const flags: CliFlags = Object.fromEntries(
			Object.entries(cmd.flags).map(([k, description]) => [k, BOOL_FLAGS.includes(k) ? { description } : { value: `<${k}>`, description }]),
		);
		plugin.registerCliHandler(`revisit:${name}`, cmd.desc, Object.keys(flags).length ? flags : null, (params) => runCli(plugin, cmd, params));
	}
}
