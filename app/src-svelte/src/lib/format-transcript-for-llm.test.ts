import { describe, expect, it } from 'vitest';
import { formatTranscriptForLlm } from './format-transcript-for-llm';

describe('formatTranscriptForLlm', () => {
	it('uses Me/Them when no names provided', () => {
		const out = formatTranscriptForLlm([
			{ text: 'hi', speaker: 'mic' },
			{ text: 'hello', speaker: 'system' },
		]);
		expect(out).toBe('Me: hi\nThem: hello');
	});

	it('uses assigned names and selfName when provided', () => {
		const names = new Map<number, string>([[1, 'Bruno']]);
		const out = formatTranscriptForLlm(
			[
				{ text: 'hi', speaker: 'mic' },
				{ text: 'hello', speaker: 'system', speaker_id: 1 },
			],
			{ names, selfName: 'Ana' },
		);
		expect(out).toBe('Ana: hi\nBruno: hello');
	});

	it('falls back to Speaker N for unnamed clusters', () => {
		const out = formatTranscriptForLlm([{ text: 'x', speaker: 'system', speaker_id: 3 }], {
			names: new Map(),
		});
		expect(out).toBe('Speaker 3: x');
	});
});
