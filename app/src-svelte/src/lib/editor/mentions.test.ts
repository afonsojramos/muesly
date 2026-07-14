import { describe, expect, it } from 'vitest';

import { filterMentionSuggestions, handleMentionKey, matchMention } from './mentions';

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
