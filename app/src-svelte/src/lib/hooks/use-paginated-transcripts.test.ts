import { describe, expect, it } from 'vitest';

import { toSegments } from './use-paginated-transcripts.svelte';
import type { Transcript } from '$lib/types';

function row(overrides: Partial<Transcript> = {}): Transcript {
	return {
		id: 't-1',
		text: 'hello',
		timestamp: '09:30:02',
		audio_start_time: 12,
		audio_end_time: 15,
		confidence: 0.9,
		speaker: 'system',
		speaker_id: 2,
		...overrides,
	};
}

describe('toSegments', () => {
	it('maps every renderer-relevant field, including speaker_id', () => {
		// Regression pin: speaker_id was once dropped here, which silently killed
		// named-speaker labels and the assign picker in the saved-meeting view.
		const [seg] = toSegments([row()]);
		expect(seg).toEqual({
			id: 't-1',
			timestamp: 12,
			endTime: 15,
			text: 'hello',
			confidence: 0.9,
			speaker: 'system',
			speaker_id: 2,
		});
	});

	it('does not invent values for absent fields', () => {
		const [seg] = toSegments([
			row({
				audio_start_time: undefined,
				audio_end_time: undefined,
				speaker: undefined,
				speaker_id: undefined,
			}),
		]);
		expect(seg?.timestamp).toBe(0);
		expect(seg?.endTime).toBeUndefined();
		expect(seg?.speaker).toBeUndefined();
		expect(seg?.speaker_id).toBeUndefined();
	});
});
