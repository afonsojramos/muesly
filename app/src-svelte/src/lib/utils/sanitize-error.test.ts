import { describe, it, expect } from 'vitest';
import { sanitizeErrorMessage } from './sanitize-error';

describe('sanitizeErrorMessage', () => {
	it('redacts macOS absolute paths', () => {
		const result = sanitizeErrorMessage('Failed to read /Users/alice/call.wav');
		expect(result).toContain('<path>');
		expect(result).not.toContain('/Users/alice');
	});

	it('redacts Windows absolute paths', () => {
		const result = sanitizeErrorMessage('Cannot open C:\\Users\\bob\\rec.wav');
		expect(result).not.toContain('C:\\Users');
	});

	it('redacts home-relative paths', () => {
		const result = sanitizeErrorMessage('open ~/Documents/x.wav failed');
		expect(result).not.toContain('~/Documents');
	});

	it('leaves plain-text messages unchanged', () => {
		const msg = 'Network timeout after 30s';
		expect(sanitizeErrorMessage(msg)).toBe(msg);
	});
});
