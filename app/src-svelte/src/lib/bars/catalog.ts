import {
	Calendar,
	FileText,
	GitBranch,
	HelpCircle,
	ListChecks,
	Mail,
	Radar,
	ScrollText,
	Search,
	Smile,
	Sparkles,
	Users,
} from '@lucide/svelte';
import type { Component } from 'svelte';

import MueslyBar from '$lib/components/icons/MueslyBar.svelte';

/**
 * Where a bar makes sense: inside a single meeting's chat (`meeting`) or the
 * Home "ask your meetings" chat that spans everything (`global`). A bar may
 * fit both.
 */
export type BarScope = 'meeting' | 'global';

/** Plain data shape (also what the gitignored imported file provides). */
export interface ImportedBar {
	id: string;
	title: string;
	description: string;
	prompt: string;
	scopes: BarScope[];
	author: string | null;
	icon: string;
}

export type BarSource = 'builtin' | 'imported' | 'user';

export interface Bar extends ImportedBar {
	source: BarSource;
}

/** Icon key -> component. Bars reference an icon by name (string) so the
 *  generated/persisted data stays serialisable; the UI resolves it here. */
const BAR_ICONS: Record<string, Component> = {
	'muesly-bar': MueslyBar,
	'scroll-text': ScrollText,
	'list-checks': ListChecks,
	sparkles: Sparkles,
	mail: Mail,
	'help-circle': HelpCircle,
	calendar: Calendar,
	users: Users,
	search: Search,
	radar: Radar,
	'git-branch': GitBranch,
	'file-text': FileText,
	smile: Smile,
};

export function barIcon(name: string): Component {
	return BAR_ICONS[name] ?? Sparkles;
}

/** Selectable icon names for the bar editor. */
export const BAR_ICON_NAMES: string[] = Object.keys(BAR_ICONS);

/** muesly's own, ship-safe bar set. The catalog works with just these even
 *  when no imported file is present. */
const BUILTIN_BARS: Bar[] = [
	{
		id: 'builtin:summary',
		title: 'Summarize',
		description: 'A concise summary of the meeting.',
		prompt: 'Give me a concise summary of this meeting.',
		scopes: ['meeting'],
		author: null,
		icon: 'scroll-text',
		source: 'builtin',
	},
	{
		id: 'builtin:actions',
		title: 'Action items',
		description: 'To-dos with owners and due dates where mentioned.',
		prompt:
			'List the action items from this meeting, with owners and due dates where mentioned. Keep each item concrete and actionable.',
		scopes: ['meeting'],
		author: null,
		icon: 'list-checks',
		source: 'builtin',
	},
	{
		id: 'builtin:decisions',
		title: 'Key decisions',
		description: 'The decisions made, and what is still open.',
		prompt: 'What key decisions were made in this meeting, and what is still unresolved?',
		scopes: ['meeting'],
		author: null,
		icon: 'git-branch',
		source: 'builtin',
	},
	{
		id: 'builtin:email',
		title: 'Follow-up email',
		description: 'A short recap email with next steps.',
		prompt:
			'Draft a short, friendly follow-up email summarizing this meeting and the agreed next steps. Use placeholders like [name] where you are missing details.',
		scopes: ['meeting'],
		author: null,
		icon: 'mail',
		source: 'builtin',
	},
	{
		id: 'builtin:missed',
		title: 'What did I miss?',
		description: 'Catch up on the last few minutes.',
		prompt:
			'I stepped away for a bit. In 1-3 bullets, what did I miss and what are the key takeaways so far?',
		scopes: ['meeting'],
		author: null,
		icon: 'help-circle',
		source: 'builtin',
	},
	{
		id: 'builtin:recent-todos',
		title: 'Recent to-dos',
		description: 'Outstanding to-dos across recent meetings.',
		prompt:
			'List my outstanding to-dos across recent meetings, grouped by urgency. For each, note the meeting it came from.',
		scopes: ['global'],
		author: null,
		icon: 'list-checks',
		source: 'builtin',
	},
	{
		id: 'builtin:weekly-recap',
		title: 'Weekly recap',
		description: 'What happened across meetings this week.',
		prompt:
			'Summarize what happened across my meetings in the last 7 days: what shipped, what got decided, and what is still open. Keep it tight.',
		scopes: ['global'],
		author: null,
		icon: 'scroll-text',
		source: 'builtin',
	},
	{
		id: 'builtin:open-decisions',
		title: 'Open decisions',
		description: 'Decisions still awaiting a call.',
		prompt:
			'Across my recent meetings, what important decisions are still unresolved or waiting on someone? Note who owns each.',
		scopes: ['global'],
		author: null,
		icon: 'git-branch',
		source: 'builtin',
	},
];

// Optionally fold in the gitignored imported set. `import.meta.glob` returns an
// empty object when the file is absent (e.g. in CI), so this stays build-safe.
const importedModules = import.meta.glob<{ IMPORTED_BARS?: ImportedBar[] }>(
	'./catalog.imported.ts',
	{ eager: true },
);
const IMPORTED_BARS: Bar[] = Object.values(importedModules).flatMap((mod) =>
	(mod.IMPORTED_BARS ?? []).map((r) => ({ ...r, source: 'imported' as const })),
);

/** Built-in + imported bars. User-created bars come from the DB separately. */
export const CATALOG_BARS: Bar[] = [...BUILTIN_BARS, ...IMPORTED_BARS];

export function catalogForScope(scope: BarScope): Bar[] {
	return CATALOG_BARS.filter((r) => r.scopes.includes(scope));
}
