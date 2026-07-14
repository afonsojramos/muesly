export interface MentionRange {
	from: number;
	to: number;
}

export interface MentionMatch {
	query: string;
	range: MentionRange;
}

export interface MentionMenuRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

export interface MentionMenuSize {
	width: number;
	height: number;
}

export interface MentionMenuPlacement {
	left: number;
	top: number;
	placement: 'above' | 'below';
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

export function placeMentionMenu(
	caret: MentionMenuRect,
	menu: MentionMenuSize,
	viewport: MentionMenuRect,
	margin = 8,
	gap = 6,
): MentionMenuPlacement {
	const minLeft = viewport.left + margin;
	const maxLeft = Math.max(minLeft, viewport.right - margin - menu.width);
	const left = Math.min(Math.max(caret.left, minLeft), maxLeft);
	const belowTop = caret.bottom + gap;
	const aboveTop = caret.top - gap - menu.height;
	const availableBelow = viewport.bottom - margin - belowTop;
	const availableAbove = caret.top - gap - (viewport.top + margin);
	const placement =
		availableBelow >= menu.height || availableBelow >= availableAbove ? 'below' : 'above';
	const preferredTop = placement === 'below' ? belowTop : aboveTop;
	const minTop = viewport.top + margin;
	const maxTop = Math.max(minTop, viewport.bottom - margin - menu.height);

	return {
		left,
		top: Math.min(Math.max(preferredTop, minTop), maxTop),
		placement,
	};
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
