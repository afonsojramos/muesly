import { describe, expect, it } from 'vitest';

import {
	buildDisplayIndex,
	emptySpeakerContext,
	isAssignable,
	speakerLabelFor,
	type SpeakerContext,
} from './speaker-label';
import type { TranscriptSegmentData } from './types';

function seg(
	id: string,
	speaker: string | undefined,
	speaker_id: number | null = null,
): TranscriptSegmentData {
	return { id, timestamp: 0, text: 'hi', speaker, speaker_id };
}

function ctx(overrides: Partial<SpeakerContext> = {}): SpeakerContext {
	return { ...emptySpeakerContext(), ...overrides };
}

describe('speakerLabelFor', () => {
	it('labels the mic side "You" when no self name is known', () => {
		expect(speakerLabelFor(seg('a', 'mic'), ctx(), new Map())).toBe('You');
	});

	it('labels the mic side with the self name when provided', () => {
		expect(speakerLabelFor(seg('a', 'mic'), ctx({ selfName: 'Ana' }), new Map())).toBe('Ana');
	});

	it('uses the assigned name for a named system cluster', () => {
		const names = new Map([[2, 'Bruno']]);
		const s = seg('a', 'system', 2);
		expect(speakerLabelFor(s, ctx({ names }), buildDisplayIndex([s]))).toBe('Bruno');
	});

	it('falls back to a contiguous "Speaker N" for an unnamed cluster', () => {
		// Raw cluster ids {1, 2} must render as "Speaker 1" / "Speaker 2".
		const first = seg('a', 'system', 1);
		const second = seg('b', 'system', 2);
		const idx = buildDisplayIndex([first, second]);
		expect(speakerLabelFor(first, ctx(), idx)).toBe('Speaker 1');
		expect(speakerLabelFor(second, ctx(), idx)).toBe('Speaker 2');
	});

	it('returns undefined for a system segment without a cluster', () => {
		expect(speakerLabelFor(seg('a', 'system', null), ctx(), new Map())).toBeUndefined();
	});
});

describe('buildDisplayIndex', () => {
	it('numbers distinct system clusters by first appearance, ignoring mic', () => {
		const segs = [
			seg('a', 'mic'),
			seg('b', 'system', 5),
			seg('c', 'system', 5),
			seg('d', 'system', 3),
		];
		const idx = buildDisplayIndex(segs);
		expect(idx.get(5)).toBe(1);
		expect(idx.get(3)).toBe(2);
		expect(idx.has(undefined as unknown as number)).toBe(false);
	});
});

describe('isAssignable', () => {
	it('is true only for system segments with a cluster', () => {
		expect(isAssignable(seg('a', 'system', 0))).toBe(true);
		expect(isAssignable(seg('a', 'system', null))).toBe(false);
		expect(isAssignable(seg('a', 'mic', 0))).toBe(false);
	});
});
