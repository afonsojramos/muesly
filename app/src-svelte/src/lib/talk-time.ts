/**
 * Pure helpers mapping backend talk-time groups to labeled display buckets.
 *
 * The backend aggregates speech seconds per `(speaker, speaker_id)` group over
 * ALL of a meeting's segments (pagination-proof); this module resolves the
 * labels the same way the transcript does — self name or "You" for the mic
 * side, assigned names from the SpeakerContext, contiguous "Speaker N" numbers
 * assigned by first appearance, and an "Other participants" bucket for
 * undiarized remote speech.
 */

import type { TalkTimeGroup } from '$lib/bindings';
import type { SpeakerContext } from '$lib/speaker-label';

export interface TalkTimeBucket {
	label: string;
	seconds: number;
	/** Share of total speech time (0..1). */
	fraction: number;
}

/** Resolve backend groups + speaker names into sorted display buckets. */
export function buildTalkTimeBuckets(
	groups: TalkTimeGroup[],
	ctx: SpeakerContext,
): TalkTimeBucket[] {
	// "Speaker N" numbering follows first appearance, matching the transcript's
	// buildDisplayIndex semantics; the backend supplies first_start per group.
	const displayIndex = new Map<number, number>();
	let next = 1;
	for (const g of [...groups].sort(
		(a, b) => (a.first_start ?? Infinity) - (b.first_start ?? Infinity),
	)) {
		if (g.speaker === 'system' && g.speaker_id != null && !displayIndex.has(g.speaker_id)) {
			displayIndex.set(g.speaker_id, next++);
		}
	}

	const totals = new Map<string, number>();
	for (const g of groups) {
		if (g.seconds <= 0) continue;
		const label = labelFor(g, ctx, displayIndex);
		if (!label) continue;
		totals.set(label, (totals.get(label) ?? 0) + g.seconds);
	}

	const total = [...totals.values()].reduce((a, b) => a + b, 0);
	if (total <= 0) return [];
	return [...totals.entries()]
		.map(([label, seconds]) => ({ label, seconds, fraction: seconds / total }))
		.sort((a, b) => b.seconds - a.seconds);
}

function labelFor(
	group: TalkTimeGroup,
	ctx: SpeakerContext,
	displayIndex: Map<number, number>,
): string | undefined {
	if (group.speaker === 'mic') {
		return ctx.selfName?.trim() || 'You';
	}
	if (group.speaker === 'system') {
		if (group.speaker_id == null) return 'Other participants';
		const assigned = ctx.names.get(group.speaker_id);
		if (assigned && assigned.trim()) return assigned;
		const index = displayIndex.get(group.speaker_id);
		return index != null ? `Speaker ${index}` : 'Other participants';
	}
	// Unknown source (legacy rows): not attributable, skip.
	return undefined;
}

/** Compact duration for the legend: `45s`, `12m`, `12m 30s`, `1h 05m`. */
export function formatSeconds(seconds: number): string {
	const total = Math.round(seconds);
	if (total < 60) return `${total}s`;
	const hours = Math.floor(total / 3600);
	const mins = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h ${mins.toString().padStart(2, '0')}m`;
	return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
