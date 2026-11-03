import { State } from 'ts-fsrs';
import { CliFlags, normalizePath, TFile } from 'obsidian';
import { areaOf, linkPath } from '../cards/area';
import { groupBy, normalizeAssunto } from '../cards/format';
import { mirrorPath } from '../cards/mirror';
import { AREAS, Card, isTipo } from '../cards/types';
import type LembroPlugin from '../main';
import { forecast } from '../srs/budget';
import { estimateMinutes, matchesFilter, QueueItem } from '../srs/queue';
import { cardStats } from '../srs/stats';
import { CliError, flag, json, need, Params, parseLote, short, unescape } from './args';

/**
 * `lembro:` commands of the Obsidian CLI, for agents. They read and write cards;
 * none of them grades a card: grading is the owner's.
 */

interface Command {
	desc: string;
	flags: Record<string, string>;
	run: (p: Params, plugin: LembroPlugin) => Promise<string>;
}

const BOOL_FLAGS = ['dry', 'reativar', 'reverso'];

function stateOf(it: QueueItem): string {
	if (it.suspended) return 'suspenso';
	if (!it.fsrs || it.fsrs.state === State.New) return 'novo';
	return it.fsrs.state === State.Review ? 'revisao' : 'aprendendo';
}

function area(p: Params): string | null {
	const a = p.area?.trim();
	if (!a) return null;
	const hit = AREAS.find((x) => x.toLowerCase() === a.toLowerCase());
	if (!hit) throw new CliError('parametro', `área desconhecida: ${a} (use ${AREAS.join(', ')})`);
	return hit;
}

function findCard(plugin: LembroPlugin, id: string): Card {
	const c = plugin.store.cards.find((x) => x.id === id.replace(/^\^/, ''));
	if (!c) throw new CliError('id', `cartão não encontrado: ${id}`);
	return c;
}

function assuntosOf(p: Params): string[] {
	return (p.assunto ?? '').split(';').map(normalizeAssunto).filter(Boolean);
}

/** Card file and derived área for a source link (or none). */
function placeFor(plugin: LembroPlugin, fonte: string): { path: string; derived: string | null } {
	const link = linkPath(fonte);
	const file = link ? plugin.app.metadataCache.getFirstLinkpathDest(link, '') : null;
	const src = file?.path ?? (link || null);
	// a source that is itself a card file would be mirrored inside the mirror (Lembro/x/Lembro/x.md)
	const folder = normalizePath(plugin.settings.folder);
	if (src && (src === folder || src.startsWith(folder + '/')))
		throw new CliError('fonte', `a fonte ${fonte} aponta para um arquivo de cartões do Lembro (${src}); use a nota de origem`);
	return { path: mirrorPath(src, plugin.settings.folder), derived: src ? areaOf(src, plugin.settings.areaMap) : null };
}

function tipoOf(value: string): Card['tipo'] {
	if (!isTipo(value)) throw new CliError('parametro', `tipo inválido: ${value} (use Pergunta, Lacuna, Referência, Questão)`);
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
				cabem: s.length,
				minutos: estimateMinutes(s, plugin.secs()),
				orcamento: plugin.settings.budgetMinutes,
				proximos7: forecast(items, plugin.secs(), new Date()),
				novos: (() => {
					const q = plugin.quota();
					return { geral: { usados: q.geral.usados, teto: q.geral.teto, cap: q.geral.cap }, areas: Object.fromEntries(q.areas.map((x) => [x.area, { usados: x.usados, teto: x.teto }])) };
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
			const rows = plugin
				.items()
				.filter((it) => matchesFilter(it, a, p.assunto))
				.filter((it) => !nota || (plugin.resolveSource(it.card) ?? '').toLowerCase().includes(nota))
				.filter((it) => !busca || `${it.card.frente}\n${it.card.verso}`.toLowerCase().includes(busca))
				.map((it) => ({ it, st: stateOf(it) }))
				.filter(({ st }) => !p.estado || st === p.estado)
				.slice(0, Number(p.limite) || 50)
				.map(({ it, st }) => {
					const id = it.card.id as string;
					return {
						id,
						frente: short(it.card.frente),
						tipo: it.card.tipo,
						area: it.area,
						assunto: it.card.assuntos,
						fonte: plugin.resolveSource(it.card),
						estado: st,
						proxima: it.fsrs && it.fsrs.state !== State.New ? it.fsrs.due.toISOString().slice(0, 10) : null,
						acertos: stats.get(id)?.ok ?? 0,
						erros: stats.get(id)?.bad ?? 0,
					};
				});
			return json(rows);
		},
	},
	ver: {
		desc: 'Mostra um cartão inteiro pelo id',
		flags: { id: 'Id do cartão (lxxxxx)' },
		run: async (p, plugin) => {
			const c = findCard(plugin, need(p, 'id'));
			return json({ id: c.id, tipo: c.tipo, frente: c.frente, verso: c.verso, area: plugin.areaOfCard(c), assunto: c.assuntos, fonte: c.fonte, arquivo: c.file });
		},
	},
	novo: {
		desc: 'Cria um cartão no arquivo-espelho da fonte',
		flags: { frente: 'Frente (\\n quebra linha)', verso: 'Verso', fonte: 'Link [[...]] da origem', assunto: 'Assunto; outro', tipo: 'Pergunta, Lacuna, Referência, Questão', area: 'Dedicação, se a fonte não disser', reverso: 'Revisar também do verso para a frente', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const tipo = tipoOf(p.tipo ?? 'Pergunta');
			const fonte = p.fonte ?? '';
			const { path, derived } = placeFor(plugin, fonte);
			const a = area(p);
			const card = {
				id: null,
				tipo,
				frente: unescape(need(p, 'frente')),
				verso: unescape(need(p, 'verso')),
				...(a && a !== derived ? { area: a } : {}),
				assuntos: assuntosOf(p),
				...(flag(p, 'reverso') ? { reverso: true } : {}),
				fonte,
			};
			if (flag(p, 'dry')) return json({ dry: true, arquivo: path, area: a ?? derived, cartao: card });
			const id = await plugin.store.addCard(path, card);
			await plugin.reload();
			return json({ ok: true, id, arquivo: path });
		},
	},
	lote: {
		desc: 'Cria vários cartões a partir de um markdown no formato do cartão (blocos separados por ---)',
		flags: { arquivo: 'Caminho no vault do markdown com os cartões', fonte: 'Fonte para os cartões sem Fonte:', assunto: 'Assunto para os cartões sem Assunto:', dry: 'Só mostra, não grava' },
		run: async (p, plugin) => {
			const path = normalizePath(need(p, 'arquivo'));
			const file = plugin.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) throw new CliError('arquivo', `arquivo não encontrado: ${path}`);
			const cards = parseLote(await plugin.app.vault.cachedRead(file)).map((c) => ({
				...c,
				fonte: c.fonte || (p.fonte ?? ''),
				assuntos: c.assuntos.length ? c.assuntos : assuntosOf(p),
			}));
			const dests = cards.map((c) => placeFor(plugin, c.fonte).path);
			if (flag(p, 'dry')) return json({ dry: true, cartoes: cards.length, arquivos: [...new Set(dests)], previa: cards.slice(0, 5).map((c) => ({ frente: short(c.frente), tipo: c.tipo, assunto: c.assuntos })) });
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
			if (missing.length) return json({ ok: false, criados: ids.length - missing.length, faltando: missing.map((it) => ({ id: it.card.id, frente: short(it.card.frente), arquivo: it.dest })) });
			return json({ ok: true, criados: ids.length, ids });
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
				tipo: tipoOf(p.tipo ?? c.tipo),
				frente: p.frente ? unescape(p.frente) : c.frente,
				verso: p.verso ? unescape(p.verso) : c.verso,
				assuntos: p.assunto ? assuntosOf(p) : c.assuntos,
			};
			if (flag(p, 'dry')) return json({ dry: true, cartao: next });
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
			const st = flag(p, 'reativar') ? 'ativo' : 'suspenso';
			if (flag(p, 'dry')) return json({ dry: true, id, estado: st });
			plugin.store.state[id] = { ...(plugin.store.state[id] ?? {}), st };
			await plugin.store.saveState();
			plugin.updateStatus();
			return json({ ok: true, id, estado: st });
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
			return json({ ok: true, cabem: plugin.session(a, minutes).length });
		},
	},
};

export async function runCli(plugin: LembroPlugin, cmd: Command, params: Params): Promise<string> {
	try {
		await plugin.reload();
		return await cmd.run({ ...params }, plugin);
	} catch (e) {
		if (e instanceof CliError) return json({ erro: e.code, mensagem: e.message });
		return json({ erro: 'interno', mensagem: e instanceof Error ? e.message : String(e) });
	}
}

/** Registers every command as `lembro:<nome>` in the Obsidian CLI. */
export function registerCli(plugin: LembroPlugin): void {
	for (const [name, cmd] of Object.entries(COMMANDS)) {
		const flags: CliFlags = Object.fromEntries(
			Object.entries(cmd.flags).map(([k, description]) => [k, BOOL_FLAGS.includes(k) ? { description } : { value: `<${k}>`, description }]),
		);
		plugin.registerCliHandler(`lembro:${name}`, cmd.desc, Object.keys(flags).length ? flags : null, (params) => runCli(plugin, cmd, params));
	}
}
