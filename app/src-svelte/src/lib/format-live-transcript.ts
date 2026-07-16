/**
 * Line formatter for the live-recording transcript copy.
 *
 * The live store has no diarized speakers, so this stays a plain
 * `[MM:SS] text` join — distinct from `format-transcript-markdown.ts`,
 * which handles saved meetings with speaker labels. Rows without an
 * `audio_start_time` (not yet aligned) show `[--:--]`.
 */

import type { Transcript } from '$lib/types';
import { formatRecordingTimestamp } from '$lib/utils/format-time';

export function formatLiveTranscriptText(
	rows: Pick<Transcript, 'audio_start_time' | 'text'>[],
	{ timestamps = true }: { timestamps?: boolean } = {},
): string {
	return rows
		.map((t) => {
			if (!timestamps) return t.text;
			const time =
				t.audio_start_time === undefined ? '[--:--]' : formatRecordingTimestamp(t.audio_start_time);
			return `${time} ${t.text}`;
		})
		.join('\n');
}
