/**
 * Helpers for linking AI summary timestamps / bullets back into the transcript.
 */

export interface TimedSegment {
	id: string;
	text: string;
	audio_start_time?: number | null;
}

/** Format recording-relative seconds for chat's clickable `[mm:ss]` citations. */
export function formatTranscriptCitation(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const remainder = total % 60;
	return `[${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}]`;
}

/** Parse `[m:ss]`, `[mm:ss]`, or bare `m:ss` at the start of a token into seconds. */
export function parseTimestampToken(token: string): number | null {
	const m = token.trim().match(/^\[?(\d{1,2}):(\d{2})\]?$/);
	if (!m) return null;
	const mins = Number(m[1]);
	const secs = Number(m[2]);
	if (!Number.isFinite(mins) || !Number.isFinite(secs) || secs >= 60) return null;
	return mins * 60 + secs;
}

/** Find the segment whose start is closest to `seconds` (prefer <= target). */
export function findSegmentNearTime(
	segments: TimedSegment[],
	seconds: number,
): TimedSegment | null {
	if (segments.length === 0) return null;
	let best: TimedSegment | null = null;
	let bestDist = Infinity;
	for (const s of segments) {
		const t = s.audio_start_time;
		if (t == null || !Number.isFinite(t)) continue;
		const dist = Math.abs(t - seconds);
		// Prefer segments that start at or before the click time when distances tie.
		if (dist < bestDist || (dist === bestDist && t <= seconds)) {
			bestDist = dist;
			best = s;
		}
	}
	return best;
}

/**
 * Wrap `[mm:ss]` tokens in markdown with a clickable HTML span for the editor.
 * Leaves other content untouched.
 */
export function linkTimestampsInMarkdown(markdown: string): string {
	return markdown.replace(/\[(\d{1,2}):(\d{2})\]/g, (_full, mm, ss) => {
		const seconds = Number(mm) * 60 + Number(ss);
		return `<span data-transcript-ts="${seconds}" class="transcript-ts cursor-pointer text-brand underline underline-offset-2">[${mm}:${ss}]</span>`;
	});
}

/** Reverse of {@link linkTimestampsInMarkdown} for clean persistence. */
export function unlinkTimestampsInMarkdown(markdown: string): string {
	return markdown.replace(
		/<span[^>]*data-transcript-ts="\d+"[^>]*>\[(\d{1,2}:\d{2})\]<\/span>/gi,
		'[$1]',
	);
}
