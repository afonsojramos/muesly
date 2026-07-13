/**
 * Format a number of seconds as a bracketed, recording-relative timestamp,
 * rolling over to hours past 60 minutes: `[MM:SS]`, or `[H:MM:SS]` once the
 * recording is an hour or longer. Shared by the transcript view, copy/export,
 * and summary timestamp hints so they format consistently.
 */
export function formatRecordingTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	const mm = mins.toString().padStart(2, '0');
	const ss = secs.toString().padStart(2, '0');
	return hours > 0 ? `[${hours}:${mm}:${ss}]` : `[${mm}:${ss}]`;
}
