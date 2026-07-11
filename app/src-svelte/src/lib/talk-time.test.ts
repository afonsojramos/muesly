import { describe, expect, it } from 'vitest';

import type { TalkTimeGroup } from './bindings';
import { emptySpeakerContext, type SpeakerContext } from './speaker-label';
import { buildTalkTimeBuckets, formatSeconds } from './talk-time';

function group(
	speaker: string | null,
	speaker_id: number | null,
	seconds: number,
	first_start: number | null = 0,
): TalkTimeGroup {
	return { speaker, speaker_id, seconds, first_start };
}

function ctx(overrides: Partial<SpeakerContext> = {}): SpeakerContext {
	return { ...emptySpeakerContext(), ...overrides };
}

describe('buildTalkTimeBuckets', () => {
	it('buckets mic, named clusters, and undiarized speech with correct fractions', () => {
		const groups = [
			group('mic', null, 60, 5),
			group('system', 0, 30, 0),
			group('system', null, 10, 20),
		];
		const names = new Map([[0, 'Ana']]);
		const buckets = buildTalkTimeBuckets(groups, ctx({ names }));

		expect(buckets.map((b) => b.label)).toEqual(['You', 'Ana', 'Other participants']);
		expect(buckets[0]?.seconds).toBe(60);
		expect(buckets.reduce((a, b) => a + b.fraction, 0)).toBeCloseTo(1);
	});

	it('numbers unnamed clusters by first appearance, matching transcript numbering', () => {
		// Cluster 3 speaks first, so it is "Speaker 1" even though its raw id is larger.
		const groups = [group('system', 3, 40, 0), group('system', 1, 20, 10)];
		const buckets = buildTalkTimeBuckets(groups, ctx());
		expect(buckets.map((b) => b.label)).toEqual(['Speaker 1', 'Speaker 2']);
	});

	it('uses the self name when known and rename updates apply via ctx', () => {
		const groups = [group('mic', null, 10), group('system', 2, 5)];
		const buckets = buildTalkTimeBuckets(
			groups,
			ctx({ selfName: 'Afonso', names: new Map([[2, 'Bruno']]) }),
		);
		expect(buckets.map((b) => b.label)).toEqual(['Afonso', 'Bruno']);
	});

	it('drops zero-second and unknown-source groups; empty input yields empty output', () => {
		expect(buildTalkTimeBuckets([], ctx())).toEqual([]);
		const buckets = buildTalkTimeBuckets(
			[group(null, null, 50), group('mic', null, 0)],
			ctx(),
		);
		expect(buckets).toEqual([]);
	});

	it('returns a single bucket as-is (hiding is the component decision)', () => {
		const buckets = buildTalkTimeBuckets([group('mic', null, 42)], ctx());
		expect(buckets).toHaveLength(1);
		expect(buckets[0]?.fraction).toBe(1);
	});

	it('merges a named cluster and whitespace-name fallback consistently', () => {
		// A whitespace-only assigned name falls back to Speaker numbering.
		const buckets = buildTalkTimeBuckets(
			[group('system', 0, 10)],
			ctx({ names: new Map([[0, '   ']]) }),
		);
		expect(buckets[0]?.label).toBe('Speaker 1');
	});
});

describe('formatSeconds', () => {
	it('formats boundary values compactly', () => {
		expect(formatSeconds(0)).toBe('0s');
		expect(formatSeconds(59)).toBe('59s');
		expect(formatSeconds(60)).toBe('1m');
		expect(formatSeconds(750)).toBe('12m 30s');
		expect(formatSeconds(3599)).toBe('59m 59s');
		expect(formatSeconds(3900)).toBe('1h 05m');
	});
});
