import type { Component } from 'svelte';
import { Calendar, Captions, Info, Mic, Settings2, Sparkles, Trash2 } from '@lucide/svelte';

// Settings sections, shared by the settings page (content) and the sidebar
// (navigation). Calendar is macOS-only; consumers filter by platform. Trash is
// kept separate so it can be pinned to the bottom of the sidebar nav.

export interface SettingsTab {
	value: string;
	label: string;
	icon: Component;
	/** Only shown on macOS (EventKit-backed features). */
	macOnly?: boolean;
}

export const SETTINGS_TABS: SettingsTab[] = [
	{ value: 'general', label: 'General', icon: Settings2 },
	{ value: 'recording', label: 'Recordings', icon: Mic },
	{ value: 'calendar', label: 'Calendar', icon: Calendar, macOnly: true },
	{ value: 'transcription', label: 'Transcription', icon: Captions },
	{ value: 'summary', label: 'Summary', icon: Sparkles },
	{ value: 'about', label: 'About', icon: Info },
];

/** Pinned to the bottom of the settings nav. */
export const SETTINGS_TRASH: SettingsTab = { value: 'trash', label: 'Trash', icon: Trash2 };

const ALL_VALUES = new Set([...SETTINGS_TABS.map((t) => t.value), SETTINGS_TRASH.value]);

/** The active tab from a URL `?tab=` value, falling back to "general". */
export function resolveSettingsTab(value: string | null): string {
	return value && ALL_VALUES.has(value) ? value : 'general';
}
