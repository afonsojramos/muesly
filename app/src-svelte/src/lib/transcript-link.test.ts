import { describe, expect, it } from 'vitest';
import {
	findSegmentNearTime,
	formatTranscriptCitation,
	linkTimestampsInMarkdown,
	parseTimestampToken,
} from './transcript-link';

describe('formatTranscriptCitation', () => {
	it('keeps long recordings in the clickable total-minute format', () => {
		expect(formatTranscriptCitation(5)).toBe('[00:05]');
		expect(formatTranscriptCitation(60 * 60 + 5)).toBe('[60:05]');
	});
});

describe('parseTimestampToken', () => {
	it('parses bracketed and bare mm:ss', () => {
		expect(parseTimestampToken('[01:05]')).toBe(65);
		expect(parseTimestampToken('0:09')).toBe(9);
	});
	it('rejects invalid', () => {
		expect(parseTimestampToken('abc')).toBeNull();
		expect(parseTimestampToken('[1:99]')).toBeNull();
	});
});

describe('findSegmentNearTime', () => {
	const segs = [
		{ id: 'a', text: 'hi', audio_start_time: 0 },
		{ id: 'b', text: 'mid', audio_start_time: 30 },
		{ id: 'c', text: 'late', audio_start_time: 90 },
	];
	it('picks nearest', () => {
		expect(findSegmentNearTime(segs, 28)?.id).toBe('b');
		expect(findSegmentNearTime(segs, 100)?.id).toBe('c');
	});
});

describe('linkTimestampsInMarkdown', () => {
	it('wraps bracketed times', () => {
		const out = linkTimestampsInMarkdown('See [01:05] for details');
		expect(out).toContain('data-transcript-ts="65"');
		expect(out).toContain('[01:05]');
	});
});
