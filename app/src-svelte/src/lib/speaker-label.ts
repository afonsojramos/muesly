/**
 * Pure helpers for resolving a transcript segment's display speaker label.
 *
 * The backend stores a coarse `speaker` source (`mic` = the local user, `system`
 * = remote participants) plus a diarized `speaker_id` cluster on system segments.
 * This module turns that into a human label: the local user reads "You" (or their
 * name), a named remote cluster reads its assigned name, and an unnamed cluster
 * reads "Speaker N" with N renumbered to a contiguous 1-based index per meeting.
 */

import type { MeetingSpeakers } from '$lib/bindings';
import type { TranscriptSegmentData } from '$lib/types';

export interface SpeakerContext {
	/** Diarized cluster `speaker_id` -> the name the user assigned it. */
	names: Map<number, string>;
	/** The local user's display name; falls back to "You" when absent. */
	selfName?: string;
	/** Remote (non-self) attendee names offered when assigning a cluster. */
	shortlist: string[];
}

/** An empty context (no names known yet). */
export function emptySpeakerContext(): SpeakerContext {
	return { names: new Map(), selfName: undefined, shortlist: [] };
}

/** Map the backend's `get_meeting_speakers` payload to a SpeakerContext. */
export function speakerContextFrom(data: MeetingSpeakers): SpeakerContext {
	return {
		names: new Map(
			data.speakers
				.filter((s): s is { speaker_id: number; name: string } => s.name != null)
				.map((s) => [s.speaker_id, s.name]),
		),
		selfName: data.self_name ?? undefined,
		shortlist: data.shortlist,
	};
}

/**
 * Map the distinct system cluster ids to contiguous 1-based display indices in
 * first-appearance order, so labels read "Speaker 1 / Speaker 2" regardless of
 * the raw cluster numbering (which can be sparse, e.g. {1, 3}).
 */
export function buildDisplayIndex(segments: TranscriptSegmentData[]): Map<number, number> {
	const order = new Map<number, number>();
	let next = 1;
	for (const s of segments) {
		if (s.speaker === 'system' && s.speaker_id != null && !order.has(s.speaker_id)) {
			order.set(s.speaker_id, next++);
		}
	}
	return order;
}

/**
 * The display label for a segment, or `undefined` when it has none (a system
 * segment that has not been diarized yet).
 */
export function speakerLabelFor(
	segment: TranscriptSegmentData,
	ctx: SpeakerContext,
	displayIndex: Map<number, number>,
): string | undefined {
	if (segment.speaker === 'mic') {
		return ctx.selfName?.trim() || 'You';
	}
	if (segment.speaker === 'system' && segment.speaker_id != null) {
		const assigned = ctx.names.get(segment.speaker_id);
		if (assigned && assigned.trim()) return assigned;
		const index = displayIndex.get(segment.speaker_id);
		return index != null ? `Speaker ${index}` : undefined;
	}
	return undefined;
}

/** Whether a system segment can be assigned/renamed (it has a diarized cluster). */
export function isAssignable(segment: TranscriptSegmentData): boolean {
	return segment.speaker === 'system' && segment.speaker_id != null;
}

/**
 * A stable signature of the distinct system clusters present in the segments,
 * used to detect when diarization has changed the cluster set so the speaker
 * context should reload. Ignores mic segments and undiarized system segments.
 */
export function clusterSignatureOf(segments: TranscriptSegmentData[]): string {
	return [
		...new Set(
			segments
				.filter((s) => s.speaker === 'system' && s.speaker_id != null)
				.map((s) => s.speaker_id as number),
		),
	]
		.sort((a, b) => a - b)
		.join(',');
}

/**
 * Resolve each segment's label plus a `show` flag that is true only at a speaker
 * change (turn boundary), so a run of the same speaker renders the label once.
 * Segments with no label (undiarized system) carry `show: false` and do not
 * break the run detection for the next labelled segment.
 */
export function buildSpeakerRows(
	segments: TranscriptSegmentData[],
	ctx: SpeakerContext,
): { label?: string; show: boolean }[] {
	const displayIndex = buildDisplayIndex(segments);
	let prev: string | undefined;
	return segments.map((s) => {
		const label = speakerLabelFor(s, ctx, displayIndex);
		const show = label != null && label !== prev;
		prev = label;
		return { label, show };
	});
}
