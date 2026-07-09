import { HelpCircle, ListChecks, Mail, ScrollText, Sparkles } from '@lucide/svelte';
import type { Component } from 'svelte';

/** A canned "recipe" prompt surfaced in the chat bar's slash menu. */
export interface Recipe {
	id: string;
	label: string;
	icon: Component;
	prompt: string;
}

export const RECIPES: Recipe[] = [
	{
		id: 'summary',
		label: 'Summarize',
		icon: ScrollText,
		prompt: 'Give me a concise summary of this meeting.',
	},
	{
		id: 'actions',
		label: 'Action items',
		icon: ListChecks,
		prompt: 'List the action items from this meeting, with owners and due dates where mentioned.',
	},
	{
		id: 'decisions',
		label: 'Key decisions',
		icon: Sparkles,
		prompt: 'What key decisions were made in this meeting?',
	},
	{
		id: 'email',
		label: 'Follow-up email',
		icon: Mail,
		prompt: 'Draft a short follow-up email summarizing this meeting and the next steps.',
	},
	{
		id: 'missed',
		label: 'What did I miss?',
		icon: HelpCircle,
		prompt: 'I stepped away for a bit. What did I miss, and what are the key takeaways so far?',
	},
];
