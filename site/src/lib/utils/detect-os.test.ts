import { describe, expect, it } from 'vitest';
import { detectOS } from './detect-os';

describe('detectOS', () => {
	it('detects macOS from user agent and platform', () => {
		expect(detectOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' })).toBe('macos');
		expect(detectOS({ platform: 'MacIntel' })).toBe('macos');
	});

	it('detects Windows', () => {
		expect(detectOS({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('windows');
	});

	it('detects Linux desktop', () => {
		expect(detectOS({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('linux');
	});

	it('returns unknown for empty input', () => {
		expect(detectOS({})).toBe('unknown');
	});

	it('does not misclassify Android as linux', () => {
		expect(detectOS({ userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8)' })).toBe('unknown');
	});

	it('does not misclassify iOS as macOS', () => {
		expect(detectOS({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' })).toBe(
			'unknown'
		);
	});
});
