import { App, PluginSettingTab, SettingDefinitionItem } from 'obsidian';
import type RevisitPlugin from './main';
import { DEFAULT_NEW_PER_DAY } from './srs/budget';

export interface RevisitSettings {
	folder: string;
	budgetMinutes: number;
	/** new cards per day, all of them together */
	newPerDay: number;
	retention: number;
	/** target retention of cards tagged #important */
	retentionImportant: number;
	interleave: boolean;
	/** words of the back text shown by each hint on a Reference card */
	hintWords: number;
	/** the `New` badge on cards seen for the first time */
	showNewBadge: boolean;
	/** a card graded Again comes back after this many cards in the same session */
	requeueGap: number;
	/** last topic used per source folder, offered on the next capture there */
	lastTopic: Record<string, string>;
	/** notes with this tag have their `::` and `==cloze==` lines read as cards; empty turns it off */
	inlineTag: string;
	/** `HH:MM` of the daily reminder, empty when off */
	reminder: string;
	/** notes with this tag are reread too; empty until the person picks one */
	rereadTag: string;
	newNotesPerDay: number;
	/** day (toDateString) the reminder last showed */
	lastReminder: string;
}

export const DEFAULT_SETTINGS: RevisitSettings = {
	folder: 'Revisit',
	budgetMinutes: 20,
	newPerDay: DEFAULT_NEW_PER_DAY,
	retention: 0.9,
	retentionImportant: 0.95,
	interleave: true,
	hintWords: 3,
	showNewBadge: true,
	requeueGap: 3,
	lastTopic: {},
	inlineTag: '#flashcards',
	reminder: '',
	rereadTag: '',
	newNotesPerDay: 2,
	lastReminder: '',
};

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
				heading: 'Review',
				items: [
					{
						name: 'Review budget per day, in minutes',
						desc: 'The session stops when it runs out, and new cards shrink on their own while due reviews take up the budget.',
						control: { type: 'number', key: 'budgetMinutes', min: 1 },
					},
					{
						name: 'New cards per day',
						desc: `How many new cards enter per day (default ${DEFAULT_NEW_PER_DAY}). 0 pauses new cards. If due reviews fill the budget, the quota shrinks for the day.`,
						control: { type: 'number', key: 'newPerDay', min: 0 },
					},
					{
						name: 'Desired retention, in %',
						desc: 'Chance of remembering on the review day. Higher reviews more often. The FSRS advises against going above 95.',
						control: { type: 'slider', key: 'retention', min: 70, max: 95, step: 1 },
					},
					{
						name: 'Retention of #important cards, in %',
						desc: 'Target for cards with a Tags: #important line. Higher than the general one, they come back more often. The ceiling is 95, which the FSRS advises.',
						control: { type: 'slider', key: 'retentionImportant', min: 70, max: 95, step: 1 },
					},
					{
						name: 'Interleave topics',
						desc: 'Mixes the topics inside the session. Off, it reviews one topic at a time.',
						control: { type: 'toggle', key: 'interleave' },
					},
					{
						name: 'A wrong card comes back after how many cards',
						desc: 'When you grade Again, the card reappears in the same session after this many cards.',
						control: { type: 'slider', key: 'requeueGap', min: 1, max: 10, step: 1 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Session',
				items: [
					{
						name: 'Words per hint',
						desc: "On Reference cards (verses, quotes, definitions), each click on Hint or the D key shows this many more words of the text.",
						control: { type: 'slider', key: 'hintWords', min: 1, max: 10, step: 1 },
					},
					{
						name: 'New badge',
						desc: 'Marks with New the card you see for the first time.',
						control: { type: 'toggle', key: 'showNewBadge' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Note rereading',
				items: [
					{
						name: 'Tag of the notes to reread',
						desc: 'Notes with this tag are reread, besides the ones you mark by command. Empty ignores the tag.',
						control: { type: 'text', key: 'rereadTag', placeholder: '#reread' },
					},
					{
						name: 'New notes to reread per day',
						desc: 'How many notes you have never reread enter per day.',
						control: { type: 'number', key: 'newNotesPerDay', min: 0 },
					},
				],
			},
			{
				type: 'group',
				heading: 'Reminder',
				items: [
					{
						name: 'Daily reminder',
						desc: 'Hour in the 20:00 format. If cards are still waiting and you have not reviewed today, a notice with a Review button shows up. Empty turns it off.',
						control: { type: 'text', key: 'reminder', placeholder: '20:00' },
					},
				],
			},
			{
				type: 'group',
				heading: 'Files',
				items: [
					{
						name: 'Cards folder',
						desc: 'Where the card files, the state and the review log live.',
						control: { type: 'text', key: 'folder', placeholder: DEFAULT_SETTINGS.folder },
					},
					{
						name: 'Tag of notes with inline cards',
						desc: 'In notes with this tag, Question::Answer, Question:::Answer (both ways) and ==cloze== lines become cards. The notes are never changed. Empty turns it off.',
						control: { type: 'text', key: 'inlineTag', placeholder: DEFAULT_SETTINGS.inlineTag },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === 'retention') return Math.round(s.retention * 100);
		if (key === 'retentionImportant') return Math.round(s.retentionImportant * 100);
		return s[key as keyof RevisitSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === 'newPerDay') {
			const n = Number(value);
			if (!Number.isFinite(n) || n < 0) return; // half-typed: keep the last valid value
			s.newPerDay = Math.floor(n);
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
		else if (key === 'inlineTag') {
			s.inlineTag = String(value).trim() ? '#' + String(value).trim().replace(/^#/, '') : '';
			await this.plugin.reload();
		} else if (key === 'rereadTag') s.rereadTag = String(value).trim() ? '#' + String(value).trim().replace(/^#/, '') : '';
		else if (key === 'newNotesPerDay') s.newNotesPerDay = Math.max(0, Number(value) || 0);
		else if (key === 'reminder') s.reminder = /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(value).trim()) ? String(value).trim() : '';
		await this.plugin.saveSettings();
		this.plugin.updateStatus();
	}
}
