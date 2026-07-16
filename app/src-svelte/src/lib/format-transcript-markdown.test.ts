import { describe, expect, it } from 'vitest';

import { formatTranscriptMarkdown } from './format-transcript-markdown';
import { emptySpeakerContext, type SpeakerContext } from './speaker-label';
import type { Transcript } from './types';

function row(
	id: string,
	text: string,
	speaker?: string,
	speaker_id?: number,
	start?: number,
	wallClock = '09:30:00',
): Transcript {
	return {
		id,
		text,
		timestamp: wallClock,
		audio_start_time: start,
		speaker,
		speaker_id,
	};
}

// Mirrors the copy path's formatter: numeric offset when known, else wall clock.
function formatTime(start: number | undefined, wallClock: string | undefined): string {
	if (start === undefined) return wallClock ?? '[--:--]';
	const m = Math.floor(start / 60);
	const s = Math.floor(start % 60);
	return `[${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}]`;
}

function ctx(overrides: Partial<SpeakerContext> = {}): SpeakerContext {
	return { ...emptySpeakerContext(), ...overrides };
}

describe('formatTranscriptMarkdown', () => {
	it('groups by turn: label at speaker changes, plain lines within a turn', () => {
		const rows = [
			row('a', 'hello there', 'mic', undefined, 1),
			row('b', 'still me', 'mic', undefined, 4),
			row('c', 'hi!', 'system', 0, 8),
		];
		const out = formatTranscriptMarkdown(rows, ctx({ names: new Map([[0, 'Ana']]) }), {
			formatTime,
		});
		expect(out).toBe(
			['**You**', '[00:01] hello there', '[00:04] still me', '', '**Ana**', '[00:08] hi!'].join(
				'\n',
			),
		);
	});

	it('renders contiguous Speaker N for unnamed clusters (UI parity)', () => {
		// Sparse raw ids {1, 3} must read Speaker 1 / Speaker 2, like the view.
		const rows = [row('a', 'first', 'system', 1, 0), row('b', 'second', 'system', 3, 5)];
		const out = formatTranscriptMarkdown(rows, ctx(), { formatTime });
		expect(out).toContain('**Speaker 1**');
		expect(out).toContain('**Speaker 2**');
	});

	it('degrades to plain timestamped lines with no speaker data', () => {
		const rows = [
			row('a', 'one', undefined, undefined, 1),
			row('b', 'two', undefined, undefined, 5),
		];
		const out = formatTranscriptMarkdown(rows, ctx(), { formatTime });
		expect(out).toBe('[00:01] one\n[00:05] two');
		expect(out).not.toContain('**');
	});

	it('keeps undiarized system text unlabeled and re-shows the next label (parity quirk)', () => {
		const rows = [
			row('a', 'labeled', 'system', 0, 0),
			row('b', 'undiarized interjection', 'system', undefined, 3),
			row('c', 'same speaker resumes', 'system', 0, 6),
		];
		const out = formatTranscriptMarkdown(rows, ctx(), { formatTime });
		const labelCount = (out.match(/\*\*Speaker 1\*\*/g) ?? []).length;
		expect(labelCount).toBe(2);
		expect(out).toContain('[00:03] undiarized interjection');
	});

	it('falls back to the wall-clock string for legacy rows without audio_start_time', () => {
		const rows = [row('a', 'old row', 'mic', undefined, undefined, '14:30:05')];
		const out = formatTranscriptMarkdown(rows, ctx(), { formatTime });
		expect(out).toContain('14:30:05 old row');
		expect(out).not.toContain('[00:00]');
	});

	it('returns empty string for no rows', () => {
		expect(formatTranscriptMarkdown([], ctx(), { formatTime })).toBe('');
	});

	describe('timestamps option', () => {
		it('defaults to timestamped output identical to passing timestamps: true', () => {
			// The markdown export calls without the option; this pins its shape.
			const rows = [row('a', 'hello there', 'mic', undefined, 1)];
			const withDefault = formatTranscriptMarkdown(rows, ctx(), { formatTime });
			const withExplicit = formatTranscriptMarkdown(rows, ctx(), { formatTime, timestamps: true });
			expect(withDefault).toBe('**You**\n[00:01] hello there');
			expect(withExplicit).toBe(withDefault);
		});

		it('omits time prefixes but keeps speaker labels when timestamps is false', () => {
			const rows = [
				row('a', 'hello there', 'mic', undefined, 1),
				row('b', 'still me', 'mic', undefined, 4),
				row('c', 'hi!', 'system', 0, 8),
			];
			const out = formatTranscriptMarkdown(rows, ctx({ names: new Map([[0, 'Ana']]) }), {
				formatTime,
				timestamps: false,
			});
			expect(out).toBe(['**You**', 'hello there', 'still me', '', '**Ana**', 'hi!'].join('\n'));
		});

		it('emits bare text lines with no speaker data when timestamps is false', () => {
			const rows = [
				row('a', 'one', undefined, undefined, 1),
				row('b', 'two', undefined, undefined, 5),
			];
			const out = formatTranscriptMarkdown(rows, ctx(), { formatTime, timestamps: false });
			expect(out).toBe('one\ntwo');
		});

		it('strips the wall-clock fallback on legacy rows when timestamps is false', () => {
			const rows = [row('a', 'old row', 'mic', undefined, undefined, '14:30:05')];
			const out = formatTranscriptMarkdown(rows, ctx(), { formatTime, timestamps: false });
			expect(out).toBe('**You**\nold row');
			expect(out).not.toContain('14:30:05');
		});

		it('returns empty string for no rows when timestamps is false', () => {
			expect(formatTranscriptMarkdown([], ctx(), { formatTime, timestamps: false })).toBe('');
		});
	});
});
