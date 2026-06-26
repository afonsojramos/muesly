// Factual, fair comparisons framed on what matters for privacy. Rows are kept to
// stable structural facts (where data is processed, account, open source, bot,
// price model, platforms), not volatile specifics like exact prices. Each entry
// includes an honest "where they're better" list so the pages build trust.

export type Advantage = 'muesly' | 'them' | 'neutral';

export type CompareRow = {
	dimension: string;
	muesly: string;
	them: string;
	advantage: Advantage;
};

export type Comparison = {
	slug: string;
	name: string;
	title: string;
	description: string;
	intro: string;
	rows: CompareRow[];
	theyreBetter: string[];
};

const sharedRows = (overrides: Partial<Record<string, CompareRow>>): CompareRow[] => {
	const base: Record<string, CompareRow> = {
		data: {
			dimension: 'Where your data is processed',
			muesly: 'On your device',
			them: 'In the cloud',
			advantage: 'muesly'
		},
		account: {
			dimension: 'Account required',
			muesly: 'No',
			them: 'Yes',
			advantage: 'muesly'
		},
		openSource: {
			dimension: 'Open source',
			muesly: 'Yes (MIT)',
			them: 'No',
			advantage: 'muesly'
		},
		bot: {
			dimension: 'Bot joins your call',
			muesly: 'No, records your audio locally',
			them: 'Yes',
			advantage: 'muesly'
		},
		price: {
			dimension: 'Price',
			muesly: 'Free',
			them: 'Free tier plus paid plans',
			advantage: 'muesly'
		},
		offline: {
			dimension: 'Works offline',
			muesly: 'Yes, with local models',
			them: 'No',
			advantage: 'muesly'
		},
		platforms: {
			dimension: 'Platforms',
			muesly: 'macOS, Windows, Linux (build from source)',
			them: 'Cloud, plus apps',
			advantage: 'neutral'
		}
	};
	return Object.values({ ...base, ...overrides }).filter(
		(row): row is CompareRow => row !== undefined
	);
};

export const comparisons: Comparison[] = [
	{
		slug: 'otter',
		name: 'Otter.ai',
		title: 'muesly vs Otter.ai: the private, local alternative',
		description:
			'Otter.ai sends a bot to your call and processes everything in the cloud. muesly records and transcribes on your device. Free and open source.',
		intro:
			'Otter is a mature, cloud meeting assistant that sends a bot (OtterPilot) into your calls and processes your conversations on its servers. muesly is the opposite by design: it records your own audio locally, transcribes and summarizes on your device, and is open source so you can verify exactly where your data goes.',
		rows: sharedRows({}),
		theyreBetter: [
			'Polished mobile apps and real-time collaboration',
			'Mature integrations and team features',
			'Cloud sync across every device out of the box'
		]
	},
	{
		slug: 'granola',
		name: 'Granola',
		title: 'muesly vs Granola: open source and on-device',
		description:
			'Granola is a polished, cloud meeting notepad. muesly keeps recording, transcription, and summaries on your device, and is open source and free.',
		intro:
			'Granola is a well-designed meeting notepad that, like muesly, captures audio without a bot. The difference is where your notes live: Granola processes and stores them in the cloud behind an account, while muesly keeps everything on your device. muesly is also open source and free, so you can audit it and run it without a subscription.',
		rows: sharedRows({
			bot: {
				dimension: 'Bot joins your call',
				muesly: 'No',
				them: 'No',
				advantage: 'neutral'
			}
		}),
		theyreBetter: [
			'Highly refined, polished interface',
			'Cloud sync and sharing across devices',
			'More mature templates and onboarding'
		]
	},
	{
		slug: 'fireflies',
		name: 'Fireflies.ai',
		title: 'muesly vs Fireflies.ai: private, no bot, open source',
		description:
			'Fireflies sends a bot to your meetings and stores transcripts in the cloud. muesly records locally on your device. Free and open source.',
		intro:
			'Fireflies is a cloud conversation-intelligence tool that joins your meetings with a bot and keeps transcripts on its servers, with deep CRM and team integrations. muesly trades that breadth for control: it records your own audio locally, processes on your device, and is open source and free.',
		rows: sharedRows({}),
		theyreBetter: [
			'Deep CRM and workflow integrations',
			'Team conversation analytics and search',
			'Mobile apps and cloud collaboration'
		]
	}
];

export function getComparison(slug: string): Comparison | undefined {
	return comparisons.find((c) => c.slug === slug);
}
