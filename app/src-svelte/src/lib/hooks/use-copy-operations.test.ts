import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(),
}));

vi.mock('$lib/bindings', () => ({
	commands: {
		getMeetingSpeakers: vi.fn().mockResolvedValue({ status: 'error', error: 'not found' }),
	},
}));

vi.mock('$lib/analytics', () => ({
	Analytics: {
		track: vi.fn(),
	},
}));

vi.mock('$lib/toast', () => ({
	toast: {
		success: vi.fn(),
		error: vi.fn(),
	},
}));

import { invoke } from '@tauri-apps/api/core';

import { Analytics } from '$lib/analytics';
import { emptySpeakerContext } from '$lib/speaker-label';
import { toast } from '$lib/toast';
import type { Transcript } from '$lib/types';
import { transcriptMarkdownBody, useCopyOperations } from './use-copy-operations.svelte';

const meeting = { id: 'meeting-1', title: 'Standup', created_at: '2024-01-01T00:00:00Z' };

function row(id: string, text: string, start: number | undefined, wallClock: string): Transcript {
	return {
		id,
		text,
		timestamp: wallClock,
		audio_start_time: start,
		speaker: 'mic',
		speaker_id: undefined,
	};
}

function operations() {
	return useCopyOperations({
		meeting,
		getMeetingTitle: () => meeting.title,
		getAiSummary: () => null,
	});
}

describe('handleCopyTranscript', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(invoke).mockResolvedValue({ transcripts: [], total_count: 0, has_more: false });
		vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('copies a timestamped body by default, toasts success, and tracks timestamps: on', async () => {
		const rows = [
			row('a', 'hello there', 5, '09:30:00'),
			row('b', 'old row', undefined, '14:30:05'),
		];
		vi.mocked(invoke).mockResolvedValue({
			transcripts: rows,
			total_count: rows.length,
			has_more: false,
		});

		await operations().handleCopyTranscript();

		const clipboardText = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
		expect(clipboardText).toContain(
			`# Transcript of the Meeting: ${meeting.id} - ${meeting.title}`,
		);
		expect(clipboardText).toContain('## Date:');
		expect(clipboardText).toContain('[00:05] hello there');
		expect(clipboardText).toContain('14:30:05 old row');

		expect(toast.success).toHaveBeenCalledWith('Transcript copied to clipboard');
		expect(Analytics.track).toHaveBeenCalledWith(
			'copy',
			expect.objectContaining({ type: 'transcript', timestamps: 'on' }),
		);
	});

	it('strips all time prefixes when timestamps is false, toasts the no-timestamps message, and tracks timestamps: off', async () => {
		const rows = [
			row('a', 'hello there', 5, '09:30:00'),
			row('b', 'old row', undefined, '14:30:05'),
		];
		vi.mocked(invoke).mockResolvedValue({
			transcripts: rows,
			total_count: rows.length,
			has_more: false,
		});

		await operations().handleCopyTranscript({ timestamps: false });

		const clipboardText = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] as string;
		expect(clipboardText).not.toMatch(/\[\d\d:\d\d\]/);
		expect(clipboardText).not.toContain('14:30:05');

		expect(toast.success).toHaveBeenCalledWith('Transcript copied (without timestamps)');
		expect(Analytics.track).toHaveBeenCalledWith(
			'copy',
			expect.objectContaining({ type: 'transcript', timestamps: 'off' }),
		);
	});

	it('shows an error toast and never writes to the clipboard when there are no transcripts', async () => {
		vi.mocked(invoke).mockResolvedValue({ transcripts: [], total_count: 0, has_more: false });

		await operations().handleCopyTranscript();

		expect(toast.error).toHaveBeenCalledWith('No transcripts available to copy');
		expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
		expect(toast.success).not.toHaveBeenCalled();
	});
});

describe('transcriptMarkdownBody', () => {
	it('defaults to timestamped lines when called with no options (pins the markdown-export default)', () => {
		const rows = [row('a', 'hello there', 5, '09:30:00')];
		const out = transcriptMarkdownBody(rows, emptySpeakerContext());
		expect(out).toContain('[00:05] hello there');
	});
});
