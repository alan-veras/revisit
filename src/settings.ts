import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import { parseAreaMap } from './cards/area';
import type LembroPlugin from './main';

export interface LembroSettings {
	folder: string;
	budgetMinutes: number;
	newPerDay: number;
	retention: number;
	interleave: boolean;
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
	newPerDay: 15,
	retention: 0.9,
	interleave: true,
	areaMap: {},
	lastAssunto: {},
	reminder: '',
	rereadTag: '#review/permanent',
	newNotesPerDay: 2,
	lastReminder: '',
};

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
				name: 'Pasta dos cartões',
				desc: 'Onde ficam os arquivos de cartões, o estado e o log de revisões.',
				control: { type: 'text', key: 'folder', placeholder: DEFAULT_SETTINGS.folder },
			},
			{
				name: 'Orçamento de revisão por dia, em minutos',
				desc: 'A sessão para quando ele acaba, e os cartões novos diminuem sozinhos quando as revisões já ocupam o orçamento.',
				control: { type: 'number', key: 'budgetMinutes', min: 1 },
			},
			{
				name: 'Cartões novos por dia',
				desc: 'O teto. O orçamento pode reduzir.',
				control: { type: 'number', key: 'newPerDay', min: 0 },
			},
			{
				name: 'Retenção desejada, em %',
				desc: 'Chance de lembrar no dia da revisão. Mais alta revisa mais vezes.',
				control: { type: 'slider', key: 'retention', min: 70, max: 97, step: 1 },
			},
			{
				name: 'Intercalar assuntos',
				desc: 'Mistura os assuntos na sessão. Desligado, revisa um assunto de cada vez.',
				control: { type: 'toggle', key: 'interleave' },
			},
			{
				name: 'Pastas com área',
				desc: 'Uma por linha, no formato pasta: área. As pastas de outputs, de resources e da bíblia já são reconhecidas.',
				control: { type: 'textarea', key: 'areaMap' },
			},
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
			{
				name: 'Lembrete diário',
				desc: 'Hora no formato 20:00. Se ainda houver cartões e você não revisou hoje, aparece um aviso com o botão Revisar. Vazio desliga.',
				control: { type: 'text', key: 'reminder', placeholder: '20:00' },
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === 'retention') return Math.round(s.retention * 100);
		if (key === 'areaMap')
			return Object.entries(s.areaMap)
				.map(([k, v]) => `${k}: ${v}`)
				.join('\n');
		return s[key as keyof LembroSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === 'folder') s.folder = String(value).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.folder;
		else if (key === 'budgetMinutes') s.budgetMinutes = Math.max(1, Number(value) || DEFAULT_SETTINGS.budgetMinutes);
		else if (key === 'newPerDay') s.newPerDay = Math.max(0, Number(value) || 0);
		else if (key === 'retention') {
			s.retention = Number(value) / 100;
			this.plugin.refreshScheduler();
		} else if (key === 'interleave') s.interleave = Boolean(value);
		else if (key === 'areaMap') s.areaMap = parseAreaMap(String(value));
		else if (key === 'rereadTag') s.rereadTag = String(value).trim() ? '#' + String(value).trim().replace(/^#/, '') : '';
		else if (key === 'newNotesPerDay') s.newNotesPerDay = Math.max(0, Number(value) || 0);
		else if (key === 'reminder') s.reminder = /^\d{1,2}:\d{2}$/.test(String(value).trim()) ? String(value).trim() : '';
		await this.plugin.saveSettings();
		this.plugin.updateStatus();
	}
}
