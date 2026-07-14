export interface MentionRange {
	from: number;
	to: number;
}

export interface MentionMatch {
	query: string;
	range: MentionRange;
}

export type MentionKeyResult =
	| { action: 'close' }
	| { action: 'move'; index: number }
	| { action: 'select'; index: number }
	| { action: 'unhandled' };

export function matchMention(textBefore: string, cursorPosition: number): MentionMatch | null {
	const match = textBefore.match(/(?:^|\s)@([^\s@]*)$/);
	if (!match) return null;
	const query = match[1] ?? '';
	return { query, range: { from: cursorPosition - query.length - 1, to: cursorPosition } };
}

export function filterMentionSuggestions(suggestions: string[], query: string): string[] {
	const normalizedQuery = query.toLowerCase();
	return suggestions.filter((name) => name.toLowerCase().includes(normalizedQuery)).slice(0, 8);
}

export function handleMentionKey(
	key: string,
	currentIndex: number,
	suggestionCount: number,
): MentionKeyResult {
	if (key === 'Escape') return { action: 'close' };
	if (suggestionCount === 0) return { action: 'unhandled' };
	if (key === 'ArrowDown' || key === 'ArrowUp') {
		const direction = key === 'ArrowDown' ? 1 : -1;
		return {
			action: 'move',
			index: (currentIndex + direction + suggestionCount) % suggestionCount,
		};
	}
	if (key === 'Enter' || key === 'Tab') return { action: 'select', index: currentIndex };
	return { action: 'unhandled' };
}
