import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type RevisitPlugin from './main';

export interface RevisitSettings {
	folder: string;
	retention: number;
}

export const DEFAULT_SETTINGS: RevisitSettings = { folder: 'Revisit', retention: 0.9 };

export class RevisitSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: RevisitPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: 'group',
				items: [
					{
						name: 'Cards folder',
						desc: 'Where the card files, the state and the review log live.',
						control: { type: 'text', key: 'folder', placeholder: DEFAULT_SETTINGS.folder },
					},
					{
						name: 'Desired retention, in %',
						desc: 'Chance of remembering on the review day. Higher reviews more often; FSRS advises against going above 95.',
						control: { type: 'slider', key: 'retention', min: 70, max: 95, step: 1 },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		return key === 'retention' ? Math.round(s.retention * 100) : s[key as keyof RevisitSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === 'folder') s.folder = String(value).trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.folder;
		else if (key === 'retention') s.retention = Math.min(95, Math.max(70, Number(value) || 90)) / 100;
		await this.plugin.saveSettings();
	}
}
