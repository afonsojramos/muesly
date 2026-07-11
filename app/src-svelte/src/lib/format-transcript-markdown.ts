/**
 * Markdown transcript formatter with UI-parity speaker labels.
 *
 * Distinct from `format-transcript-for-llm.ts` (chat prompts, "Me"/"Them",
 * raw cluster numbers): this formatter mirrors the transcript VIEW exactly —
 * self name or "You", assigned names, contiguous 1-based "Speaker N" — via the
 * same `speaker-label.ts` helpers the view renders with. Used by copy-transcript
 * and the markdown export.
 *
 * Turn-grouped: a bold label line opens each speaker change (reusing
 * `buildSpeakerRows`, including its parity quirk where a speaker resuming after
 * an undiarized interruption re-shows their label); lines within a turn keep
 * their timestamps. With no speaker data the output degrades to plain
 * `[mm:ss] text` lines — today's shape.
 */

import { toSegments } from '$lib/hooks/use-paginated-transcripts.svelte';
import { buildSpeakerRows, type SpeakerContext } from '$lib/speaker-label';
import type { Transcript } from '$lib/types';

export interface FormatTranscriptMarkdownOptions {
	/** Render a line's time: numeric recording offset when known, else the
	 * row's wall-clock string (legacy rows have no audio_start_time). */
	formatTime: (start: number | undefined, wallClock: string | undefined) => string;
}

export function formatTranscriptMarkdown(
	rows: Transcript[],
	ctx: SpeakerContext,
	{ formatTime }: FormatTranscriptMarkdownOptions,
): string {
	if (rows.length === 0) return '';
	const speakerRows = buildSpeakerRows(toSegments(rows), ctx);

	const lines: string[] = [];
	rows.forEach((row, i) => {
		const speaker = speakerRows[i];
		if (speaker?.show && speaker.label) {
			if (lines.length > 0) lines.push('');
			lines.push(`**${speaker.label}**`);
		}
		const time = formatTime(row.audio_start_time, row.timestamp);
		lines.push(`${time} ${row.text}`.trimEnd());
	});
	return lines.join('\n');
}
