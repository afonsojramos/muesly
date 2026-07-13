/**
 * Format transcript segments for LLM prompts (summary, title, chat live context).
 * Prefers assigned speaker names when provided; falls back to Me/Them.
 */

export interface LlmTranscriptSegment {
	text: string;
	speaker?: string | null;
	speaker_id?: number | null;
	audio_start_time?: number | null;
	timestamp?: string | number | null;
}

export interface LlmSpeakerNames {
	/** cluster id -> assigned name */
	names?: Map<number, string> | Record<number, string>;
	selfName?: string;
}

function nameFor(segment: LlmTranscriptSegment, ctx: LlmSpeakerNames | undefined): string {
	const names = ctx?.names;
	const lookup = (id: number): string | undefined => {
		if (!names) return undefined;
		if (names instanceof Map) return names.get(id);
		return (names as Record<number, string>)[id];
	};

	if (segment.speaker === 'mic') {
		const self = ctx?.selfName?.trim();
		return self || 'Me';
	}
	if (segment.speaker === 'system') {
		if (segment.speaker_id != null) {
			const assigned = lookup(segment.speaker_id)?.trim();
			if (assigned) return assigned;
			return `Speaker ${segment.speaker_id}`;
		}
		return 'Them';
	}
	if (segment.speaker_id != null) {
		const assigned = lookup(segment.speaker_id)?.trim();
		if (assigned) return assigned;
		return `Speaker ${segment.speaker_id}`;
	}
	return '';
}

/**
 * One line per non-empty segment: `Label: text`. Optional timestamps when
 * `includeTimestamps` is true (summary path).
 */
export function formatTranscriptForLlm(
	segments: LlmTranscriptSegment[],
	opts?: LlmSpeakerNames & {
		includeTimestamps?: boolean;
		formatTime?: (
			start: number | null | undefined,
			ts: string | number | null | undefined,
		) => string;
	},
): string {
	return segments
		.map((t) => {
			const text = (t.text ?? '').trim();
			if (!text) return '';
			const label = nameFor(t, opts);
			const body = label ? `${label}: ${text}` : text;
			if (opts?.includeTimestamps && opts.formatTime) {
				return `${opts.formatTime(t.audio_start_time, t.timestamp)} ${body}`;
			}
			return body;
		})
		.filter((line) => line.length > 0)
		.join('\n');
}
