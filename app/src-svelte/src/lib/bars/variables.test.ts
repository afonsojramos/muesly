import { describe, expect, it } from 'vitest';

import { barVariables, fillBarVariables, variableLabel } from './variables';

describe('bar variables', () => {
	it('extracts unique variables in appearance order', () => {
		expect(barVariables('Email {{ recipient }} about {{Topic}} for {{recipient}}')).toEqual([
			'recipient',
			'Topic',
		]);
	});

	it('fills variables case-insensitively and preserves unanswered placeholders', () => {
		expect(fillBarVariables('{{Tone}} note for {{recipient}}', { tone: 'Friendly' })).toBe(
			'Friendly note for {{recipient}}',
		);
	});

	it('creates human labels', () => {
		expect(variableLabel('target-audience')).toBe('Target Audience');
	});
});
