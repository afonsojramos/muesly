import { describe, expect, it } from 'vitest';

import {
	filterMentionSuggestions,
	handleMentionKey,
	matchMention,
	placeMentionMenu,
} from './mentions';

const viewport = { left: 0, top: 0, right: 800, bottom: 600 };
const menu = { width: 256, height: 240 };

describe('placeMentionMenu', () => {
	it('places the menu below the caret when there is room', () => {
		expect(
			placeMentionMenu({ left: 100, top: 100, right: 101, bottom: 120 }, menu, viewport),
		).toEqual({ left: 100, top: 126, placement: 'below' });
	});

	it('flips above the caret when there is more room above', () => {
		expect(
			placeMentionMenu({ left: 100, top: 520, right: 101, bottom: 540 }, menu, viewport),
		).toEqual({ left: 100, top: 274, placement: 'above' });
	});

	it('clamps against the right viewport margin', () => {
		expect(
			placeMentionMenu({ left: 750, top: 100, right: 751, bottom: 120 }, menu, viewport).left,
		).toBe(536);
	});

	it('clamps against the left viewport margin', () => {
		expect(
			placeMentionMenu({ left: -20, top: 100, right: -19, bottom: 120 }, menu, viewport).left,
		).toBe(8);
	});

	it('keeps the menu anchored within a viewport smaller than the menu', () => {
		const tinyViewport = { left: 20, top: 30, right: 180, bottom: 150 };
		expect(
			placeMentionMenu({ left: 100, top: 80, right: 101, bottom: 100 }, menu, tinyViewport),
		).toEqual({ left: 28, top: 38, placement: 'below' });
	});
});

describe('matchMention', () => {
	it('activates immediately after @', () => {
		expect(matchMention('@', 12)).toEqual({ query: '', range: { from: 11, to: 12 } });
	});

	it('captures a query and replacement range after whitespace', () => {
		expect(matchMention('Talk to @Al', 20)).toEqual({ query: 'Al', range: { from: 17, to: 20 } });
	});

	it('does not activate for an email-like embedded @', () => {
		expect(matchMention('person@example', 15)).toBeNull();
	});
});

describe('filterMentionSuggestions', () => {
	it('filters case-insensitively', () => {
		expect(filterMentionSuggestions(['Alice', 'Bob', 'ALAN'], 'al')).toEqual(['Alice', 'ALAN']);
	});

	it('returns no suggestions for empty participants', () => {
		expect(filterMentionSuggestions([], '')).toEqual([]);
	});
});

describe('handleMentionKey', () => {
	it('closes on Escape even without suggestions', () => {
		expect(handleMentionKey('Escape', 0, 0)).toEqual({ action: 'close' });
	});

	it('wraps ArrowDown from the last suggestion', () => {
		expect(handleMentionKey('ArrowDown', 2, 3)).toEqual({ action: 'move', index: 0 });
	});

	it('wraps ArrowUp from the first suggestion', () => {
		expect(handleMentionKey('ArrowUp', 0, 3)).toEqual({ action: 'move', index: 2 });
	});

	it.each(['Enter', 'Tab'])('selects the highlighted suggestion with %s', (key) => {
		expect(handleMentionKey(key, 1, 3)).toEqual({ action: 'select', index: 1 });
	});

	it('leaves selection keys unhandled without participants', () => {
		expect(handleMentionKey('Enter', 0, 0)).toEqual({ action: 'unhandled' });
	});
});
