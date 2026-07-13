// Fictional sample meeting used by the product mocks. Deliberately generic —
// no real names, companies, or identifiable content.

export type TranscriptSegment = { speaker: string; time: string; text: string };

export const meeting = {
	title: 'Q3 Roadmap Sync',
	meta: 'Today · 24 min',
};

export const transcript: TranscriptSegment[] = [
	{
		speaker: 'Speaker 1',
		time: '00:02',
		text: "Let's lock the launch date before we get into scope.",
	},
	{ speaker: 'Speaker 2', time: '00:09', text: 'The 14th works if onboarding is ready by then.' },
	{
		speaker: 'Speaker 1',
		time: '00:21',
		text: 'Onboarding is the risk. Can we cut the import step for v1?',
	},
	{
		speaker: 'Speaker 2',
		time: '00:33',
		text: 'Yes — ship core capture first, add import the week after.',
	},
	{ speaker: 'Speaker 1', time: '00:48', text: "Agreed. I'll send the updated timeline today." },
];

export const rawNotes = [
	'launch date?',
	'onboarding not ready',
	'cut import for v1?',
	'send timeline',
];

export const summary = {
	overview:
		'The team agreed to launch on the 14th, scoping v1 to core capture and deferring the import flow by one week to de-risk onboarding.',
	decisions: ['Launch date set to the 14th', 'Import step deferred to the week after launch'],
	actions: [
		{ who: 'Speaker 1', task: 'Send the updated timeline today' },
		{ who: 'Speaker 2', task: 'Confirm onboarding readiness by the 12th' },
	],
};
