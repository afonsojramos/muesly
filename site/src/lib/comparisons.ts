// Factual, fair comparisons framed on what matters for privacy. Rows are kept to
// stable structural facts (where data is processed, account, public source, bot,
// price model, platforms), not volatile specifics like exact prices. Each entry
// includes an honest "where they're better" list so the pages build trust.

export type Advantage = 'muesly' | 'them' | 'neutral';
export type CompareCategory =
	| 'Privacy & ownership'
	| 'Capture & intelligence'
	| 'Access & availability';

export type CompareRow = {
	category: CompareCategory;
	dimension: string;
	muesly: string;
	them: string;
	advantage: Advantage;
};

export type Comparison = {
	slug: string;
	name: string;
	shortName: string;
	title: string;
	description: string;
	intro: string;
	verdict: string;
	bestFor: string;
	rows: CompareRow[];
	theyreBetter: string[];
	sources: { label: string; href: string }[];
};

const sharedRows = (overrides: Partial<Record<string, CompareRow>>): CompareRow[] => {
	const base: Record<string, CompareRow> = {
		processing: {
			category: 'Privacy & ownership',
			dimension: 'Speech and AI processing',
			muesly: 'On-device by default; cloud AI is optional',
			them: 'Vendor-managed cloud',
			advantage: 'muesly',
		},
		storage: {
			category: 'Privacy & ownership',
			dimension: 'Transcript and notes storage',
			muesly: 'Local database',
			them: 'Vendor-managed cloud storage',
			advantage: 'muesly',
		},
		account: {
			category: 'Privacy & ownership',
			dimension: 'Account required',
			muesly: 'No',
			them: 'Yes',
			advantage: 'muesly',
		},
		openSource: {
			category: 'Privacy & ownership',
			dimension: 'Source code public',
			muesly: 'Yes (PolyForm Noncommercial)',
			them: 'No',
			advantage: 'muesly',
		},
		capture: {
			category: 'Capture & intelligence',
			dimension: 'Meeting capture',
			muesly: 'Desktop app; no bot',
			them: 'Meeting bot',
			advantage: 'neutral',
		},
		price: {
			category: 'Access & availability',
			dimension: 'Price',
			muesly: 'Free for personal and noncommercial use',
			them: 'Free tier plus paid plans',
			advantage: 'muesly',
		},
		offline: {
			category: 'Capture & intelligence',
			dimension: 'Offline transcription and AI',
			muesly: 'Yes, with local models',
			them: 'No',
			advantage: 'muesly',
		},
		platforms: {
			category: 'Access & availability',
			dimension: 'Platforms',
			muesly: 'macOS and Windows; Linux from source',
			them: 'Cloud, plus apps',
			advantage: 'neutral',
		},
	};
	return Object.values({ ...base, ...overrides }).filter(
		(row): row is CompareRow => row !== undefined,
	);
};

export const comparisons: Comparison[] = [
	{
		slug: 'otter',
		name: 'Otter.ai',
		shortName: 'Otter',
		title: 'muesly vs Otter.ai: the private, local alternative',
		description:
			'Otter is a mature cloud meeting agent. muesly keeps transcription, summaries, and your conversation history on your own device by default.',
		intro:
			'Otter is a mature cloud meeting agent with collaboration, mobile apps, integrations, and AI chat across meetings. muesly takes a deliberately different path: the app captures your own audio, processes it locally by default, and stores the result on your machine.',
		verdict: 'Choose Otter for a mature team cloud. Choose muesly for a private local memory.',
		bestFor: 'Private, offline capture with no account or vendor-hosted meeting archive.',
		rows: sharedRows({
			capture: {
				category: 'Capture & intelligence',
				dimension: 'Meeting capture',
				muesly: 'Desktop app; no bot',
				them: 'OtterPilot, desktop/mobile apps, or Chrome extension',
				advantage: 'neutral',
			},
			platforms: {
				category: 'Access & availability',
				dimension: 'Platforms',
				muesly: 'macOS and Windows; Linux from source',
				them: 'Web, macOS, Windows, iOS, Android, Chrome',
				advantage: 'them',
			},
		}),
		theyreBetter: [
			'iOS and Android apps for capture on the move',
			'Real-time collaboration, admin controls, and team workflows',
			'Broader integrations and automatic cloud sync across devices',
		],
		sources: [
			{ label: 'Otter pricing and features', href: 'https://otter.ai/pricing' },
			{ label: 'Otter apps and integrations', href: 'https://otter.ai/apps' },
		],
	},
	{
		slug: 'granola',
		name: 'Granola',
		shortName: 'Granola',
		title: 'muesly vs Granola: source-available and on-device',
		description:
			'Granola is a polished, bot-free cloud meeting notepad. muesly makes the same quiet capture philosophy local, offline-capable, and source-available.',
		intro:
			'Granola and muesly share a bot-free approach: both capture microphone and system audio directly. The architectural difference is what happens next. Granola uses cloud transcription and AI providers and stores meeting data on AWS; muesly can transcribe, summarize, and store everything on your device.',
		verdict:
			'Granola’s thoughtful workflow, with the option to keep the transcript and AI on your machine.',
		bestFor: 'A Granola-like workflow where the transcript and AI can stay on your machine.',
		rows: sharedRows({
			capture: {
				category: 'Capture & intelligence',
				dimension: 'Meeting capture',
				muesly: 'Desktop app; no bot',
				them: 'Desktop or iPhone app; no bot',
				advantage: 'neutral',
			},
			platforms: {
				category: 'Access & availability',
				dimension: 'Platforms',
				muesly: 'macOS and Windows; Linux from source',
				them: 'macOS, Windows, and iPhone',
				advantage: 'neutral',
			},
		}),
		theyreBetter: [
			'iPhone capture for in-person meetings and outbound calls',
			'Polished sharing, team folders, and cloud collaboration',
			'Broad integrations through Slack, Notion, CRMs, Zapier, MCP, and an API',
		],
		sources: [
			{
				label: 'Granola security and data FAQ',
				href: 'https://docs.granola.ai/help-center/consent-security-privacy/security-privacy-data-faqs',
			},
			{
				label: 'Granola subscriptions and billing',
				href: 'https://docs.granola.ai/help-center/managing-your-account/subscriptions-and-billing',
			},
			{
				label: 'Granola integrations',
				href: 'https://docs.granola.ai/help-center/sharing/integrations/integrations-with-granola',
			},
		],
	},
	{
		slug: 'fireflies',
		name: 'Fireflies.ai',
		shortName: 'Fireflies',
		title: 'muesly vs Fireflies.ai: private, no bot, source-available',
		description:
			'Fireflies is a cloud conversation-intelligence platform with extensive team features. muesly prioritizes local processing, offline use, and user-owned data.',
		intro:
			'Fireflies is a broad cloud conversation-intelligence platform with bots, bot-free browser capture, mobile apps, analytics, and deep workflow integrations. muesly trades that enterprise breadth for a smaller trust boundary: capture, transcription, AI, and storage can all stay on your machine.',
		verdict:
			'Choose Fireflies for enterprise workflows. Choose muesly to keep the trust boundary small.',
		bestFor:
			'Individual control, local AI, and offline operation instead of a team cloud platform.',
		rows: sharedRows({
			capture: {
				category: 'Capture & intelligence',
				dimension: 'Meeting capture',
				muesly: 'Desktop app; no bot',
				them: 'Meeting bot, desktop/mobile apps, or bot-free Chrome extension',
				advantage: 'neutral',
			},
			platforms: {
				category: 'Access & availability',
				dimension: 'Platforms',
				muesly: 'macOS and Windows; Linux from source',
				them: 'Web, desktop, iOS, Android, Chrome',
				advantage: 'them',
			},
		}),
		theyreBetter: [
			'Deep CRM and workflow integrations',
			'Team conversation analytics and search',
			'Mobile apps and cloud collaboration',
		],
		sources: [
			{ label: 'Fireflies pricing and features', href: 'https://fireflies.ai/pricing' },
			{ label: 'Fireflies mobile app', href: 'https://fireflies.ai/blog/fireflies-mobile-app/' },
		],
	},
];

export function getComparison(slug: string): Comparison | undefined {
	return comparisons.find((c) => c.slug === slug);
}
