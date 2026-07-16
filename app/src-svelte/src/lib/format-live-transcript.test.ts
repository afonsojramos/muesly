import { describe, expect, it } from 'vitest';

import { formatLiveTranscriptText } from './format-live-transcript';

const rows = [
	{ audio_start_time: 1, text: 'hello there' },
	{ audio_start_time: 65, text: 'still talking' },
];

describe('formatLiveTranscriptText', () => {
	it('emits [MM:SS]-prefixed lines by default', () => {
		expect(formatLiveTranscriptText(rows)).toBe('[00:01] hello there\n[01:05] still talking');
	});

	it('falls back to [--:--] for rows without audio_start_time', () => {
		expect(formatLiveTranscriptText([{ audio_start_time: undefined, text: 'unaligned' }])).toBe(
			'[--:--] unaligned',
		);
	});

	it('emits bare text lines when timestamps is false', () => {
		expect(formatLiveTranscriptText(rows, { timestamps: false })).toBe(
			'hello there\nstill talking',
		);
	});

	it('strips the [--:--] fallback too when timestamps is false', () => {
		expect(
			formatLiveTranscriptText([{ audio_start_time: undefined, text: 'unaligned' }], {
				timestamps: false,
			}),
		).toBe('unaligned');
	});

	it('returns empty string for no rows', () => {
		expect(formatLiveTranscriptText([])).toBe('');
	});
});
