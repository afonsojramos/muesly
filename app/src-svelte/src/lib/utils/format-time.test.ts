import { describe, expect, it } from 'vitest';

import { formatRecordingTimestamp } from './format-time';

describe('formatRecordingTimestamp', () => {
	it('formats sub-hour times as [MM:SS]', () => {
		expect(formatRecordingTimestamp(0)).toBe('[00:00]');
		expect(formatRecordingTimestamp(65)).toBe('[01:05]');
		expect(formatRecordingTimestamp(59 * 60 + 59)).toBe('[59:59]');
	});

	it('rolls over to [H:MM:SS] past 60 minutes', () => {
		expect(formatRecordingTimestamp(60 * 60)).toBe('[1:00:00]');
		expect(formatRecordingTimestamp(75 * 60 + 30)).toBe('[1:15:30]');
		expect(formatRecordingTimestamp(2 * 3600 + 3 * 60 + 4)).toBe('[2:03:04]');
	});

	it('floors fractional seconds and clamps negatives', () => {
		expect(formatRecordingTimestamp(5.9)).toBe('[00:05]');
		expect(formatRecordingTimestamp(-3)).toBe('[00:00]');
	});
});
