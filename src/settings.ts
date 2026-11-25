import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type RevisitPlugin from './main';

export interface RevisitSettings {
	folder: string;
	retention: number;
}

export const DEFAULT_SETTINGS: RevisitSettings = { folder: 'Revisit', retention: 0.9 };

export class RevisitSettingTab extends PluginSettingTab {
	/** the folder being typed: it only counts once typing stops, so a half-typed parent folder is never read (nor given card ids) */
	private pendingFolder: string | null = null;
	private folderTimer = 0;

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
		if (key === 'folder' && this.pendingFolder !== null) return this.pendingFolder;
		return key === 'retention' ? Math.round(s.retention * 100) : s[key as keyof RevisitSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === 'folder') {
			this.pendingFolder = String(value);
			window.clearTimeout(this.folderTimer);
			this.folderTimer = window.setTimeout(() => {
				s.folder = (this.pendingFolder ?? '').trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.folder;
				this.pendingFolder = null;
				void this.plugin.saveSettings();
			}, 1000);
			return;
		} else if (key === 'retention') s.retention = Math.min(95, Math.max(70, Number(value) || 90)) / 100;
		await this.plugin.saveSettings();
	}

	hide(): void {
		// closing the settings right after typing still saves the folder
		if (this.pendingFolder !== null) {
			window.clearTimeout(this.folderTimer);
			this.plugin.settings.folder = this.pendingFolder.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.folder;
			this.pendingFolder = null;
			void this.plugin.saveSettings();
		}
		super.hide();
	}
}
