import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import { parseAreaMap } from './cards/area';
import { AREAS } from './cards/types';
import type LembroPlugin from './main';
import { DEFAULT_AREA_CAP } from './srs/budget';

export interface LembroSettings {
	folder: string;
	budgetMinutes: number;
	/** new cards per day of each area; an area left out gets DEFAULT_AREA_CAP */
	newPerArea: Record<string, number>;
	retention: number;
	/** target retention of cards tagged #importante */
	retentionImportant: number;
	interleave: boolean;
	/** words of the text shown by each Dica on a Referência */
	hintWords: number;
	/** the `Novo` badge on cards seen for the first time */
	showNewBadge: boolean;
	/** a card graded Errei comes back after this many cards in the same session */
	requeueGap: number;
	/** extra `pasta: Área` pairs for folders outside 3_Outputs, 4_Resources and 2_The Bible */
	areaMap: Record<string, string>;
	lastAssunto: Record<string, string>;
	/** `HH:MM` of the daily reminder, empty when off */
	reminder: string;
	/** notes with this tag are reread too */
	rereadTag: string;
	newNotesPerDay: number;
	/** day (toDateString) the reminder last showed */
	lastReminder: string;
}

export const DEFAULT_SETTINGS: LembroSettings = {
	folder: '8_System/Lembro',
	budgetMinutes: 20,
	newPerArea: {},
	retention: 0.9,
	retentionImportant: 0.95,
	interleave: true,
	hintWords: 3,
	showNewBadge: true,
	requeueGap: 3,
	areaMap: {},
	lastAssunto: {},
	reminder: '',
	rereadTag: '#review/permanent',
	newNotesPerDay: 2,
	lastReminder: '',
};

/** Settings key of an area's own cap: `cota:Espiritual`. */
const COTA = 'cota:';

export class LembroSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: LembroPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				heading: 'Cartões novos por dia',
				items: AREAS.map((area) => ({
					name: area,
					desc: `Quantos cartões novos de ${area} entram por dia (padrão ${DEFAULT_AREA_CAP}). 0 pausa os novos da área. Se as revisões vencidas encherem o orçamento, a cota encolhe no dia.`,
					control: { type: 'number' as const, key: `${COTA}${area}`, min: 0 },
				})),
			},
			{
				type: 'group',
				heading: 'Revisão',
				items: [
					{
						name: 'Orçamento de revisão por dia, em minutos',
						desc: 'A sessão para quando ele acaba, e os cartões novos diminuem sozinhos quando as revisões já ocupam o orçamento.',
						control: { type: 'number', key: 'budgetMinutes', min: 1 },
					},
					{
						name: 'Retenção desejada, em %',
						desc: 'Chance de lembrar no dia da revisão. Mais alta revisa mais vezes. Acima de 95 o FSRS recomenda não passar.',
						control: { type: 'slider', key: 'retention', min: 70, max: 95, step: 1 },
					},
					{
						name: 'Retenção dos cartões #importante, em %',
						desc: 'Meta para os cartões com a linha Tags: #importante. Mais alta que a geral, eles voltam mais vezes. O teto é 95, teto que o FSRS recomenda.',
						control: { type: 'slider', key: 'retentionImportant', min: 70, max: 95, step: 1 },
					},
					{
						name: 'Intercalar assuntos',
						desc: 'Mistura os assuntos na sessão. Desligado, revisa um assunto de cada vez.',
						control: { type: 'toggle', key: 'interleave' },
					},
					{
						name: 'Cartão errado volta depois de quantos cartões',
						desc: 'Quando você marca Errei, o cartão reaparece na mesma sessão depois deste número de cartões.',
						control: { type: 'slider', key: 'requeueGap', min: 1, max: 10, step: 1 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Sessão',
				items: [
					{
						name: 'Palavras por dica',
						desc: 'Nas Referências (versículos), cada clique em Dica ou tecla D mostra mais este número de palavras do texto.',
						control: { type: 'slider', key: 'hintWords', min: 1, max: 10, step: 1 },
					},
					{
						name: 'Etiqueta Novo',
						desc: 'Marca com Novo o cartão que você vê pela primeira vez.',
						control: { type: 'toggle', key: 'showNewBadge' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Releitura de notas',
				items: [
					{
						name: 'Tag das notas para reler',
						desc: 'Notas com esta tag entram na releitura, além das que você marca pelo comando. Vazio ignora a tag.',
						control: { type: 'text', key: 'rereadTag', placeholder: '#review/permanent' },
					},
					{
						name: 'Notas novas para reler por dia',
						desc: 'Quantas notas que você nunca releu entram por dia.',
						control: { type: 'number', key: 'newNotesPerDay', min: 0 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Lembrete',
				items: [
					{
						name: 'Lembrete diário',
						desc: 'Hora no formato 20:00. Se ainda houver cartões e você não revisou hoje, aparece um aviso com o botão Revisar. Vazio desliga.',
						control: { type: 'text', key: 'reminder', placeholder: '20:00' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Arquivos',
				items: [
					{
						name: 'Pasta dos cartões',
						desc: 'Onde ficam os arquivos de cartões, o estado e o log de revisões.',
						control: { type: 'text', key: 'folder', placeholder: DEFAULT_SETTINGS.folder },
					},
					{
						name: 'Pastas com área',
						desc: 'Uma por linha, no formato pasta: área. As pastas de outputs, de resources e da bíblia já são reconhecidas.',
						control: { type: 'textarea', key: 'areaMap' },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key.startsWith(COTA)) {
			return s.newPerArea[key.slice(COTA.length)] ?? DEFAULT_AREA_CAP;
		}
		if (key === 'retention') return Math.round(s.retention * 100);
		if (key === 'retentionImportant') return Math.round(s.retentionImportant * 100);
		if (key === 'areaMap')
			return Object.entries(s.areaMap)
				.map(([k, v]) => `${k}: ${v}`)
				.join('\n');
		return s[key as keyof LembroSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key.startsWith(COTA)) {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0) return; // half-typed: keep the last valid value
			s.newPerArea = { ...s.newPerArea, [key.slice(COTA.length)]: Math.floor(n) };
		} else if (key === 'folder') s.folder = String(value).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.folder;
		else if (key === 'budgetMinutes') s.budgetMinutes = Math.max(1, Number(value) || DEFAULT_SETTINGS.budgetMinutes);
		else if (key === 'retention') {
			s.retention = Math.min(95, Number(value)) / 100;
			this.plugin.refreshScheduler();
		} else if (key === 'retentionImportant') {
			s.retentionImportant = Math.min(95, Number(value)) / 100;
			this.plugin.refreshScheduler();
		} else if (key === 'interleave') s.interleave = Boolean(value);
		else if (key === 'requeueGap') s.requeueGap = Math.min(10, Math.max(1, Number(value) || DEFAULT_SETTINGS.requeueGap));
		else if (key === 'hintWords') s.hintWords = Math.min(10, Math.max(1, Number(value) || DEFAULT_SETTINGS.hintWords));
		else if (key === 'showNewBadge') s.showNewBadge = Boolean(value);
		else if (key === 'areaMap') s.areaMap = parseAreaMap(String(value));
		else if (key === 'rereadTag') s.rereadTag = String(value).trim() ? '#' + String(value).trim().replace(/^#/, '') : '';
		else if (key === 'newNotesPerDay') s.newNotesPerDay = Math.max(0, Number(value) || 0);
		else if (key === 'reminder') s.reminder = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value).trim()) ? String(value).trim() : '';
		await this.plugin.saveSettings();
		this.plugin.updateStatus();
	}
}
