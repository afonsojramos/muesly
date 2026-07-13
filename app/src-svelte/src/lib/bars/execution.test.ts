import { describe, expect, it } from 'vitest';

import { addBarInstructions, parseBarCommandDraft } from './execution';

describe('addBarInstructions', () => {
	it('leaves the authored prompt unchanged without a refinement', () => {
		expect(addBarInstructions('List recent to-dos.')).toBe('List recent to-dos.');
	});

	it('appends one-off slash command context as separate instructions', () => {
		expect(addBarInstructions('List recent to-dos.', 'related to project X?')).toBe(
			'List recent to-dos.\n\nAdditional instructions from the user:\nrelated to project X?',
		);
	});
});

describe('parseBarCommandDraft', () => {
	it('keeps optional context after the slash command', () => {
		expect(parseBarCommandDraft('/recent-todos related to project X?')).toEqual({
			slug: 'recent-todos',
			additionalInstructions: 'related to project X?',
		});
	});

	it('preserves multiline refinements', () => {
		expect(parseBarCommandDraft('/recent-todos project X\nOnly overdue items')).toEqual({
			slug: 'recent-todos',
			additionalInstructions: 'project X\nOnly overdue items',
		});
	});

	it('ignores ordinary chat messages', () => {
		expect(parseBarCommandDraft('What are my recent todos?')).toBeNull();
	});
});
