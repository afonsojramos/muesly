/**
 * useSpeakerContext
 *
 * Owns the per-meeting named-speaker state for the meeting-details transcript:
 * loads assigned names + the attendee shortlist, exposes them reactively, and
 * persists renames. Extracted from SidePanel so the load/rename race and error
 * handling live in one place.
 *
 * Concurrency: a monotonic `genId` invalidates in-flight loads. Switching
 * meetings resets the context immediately (so the previous meeting's names never
 * bleed onto another meeting's transcript), and a rename bumps `genId` so a
 * load that was already in flight can't clobber the just-assigned name.
 */

import { commands } from '$lib/bindings';
import type { TranscriptSegmentData } from '$lib/types';
import { clusterSignatureOf, emptySpeakerContext, type SpeakerContext } from '$lib/speaker-label';
import { toast } from '$lib/toast';

export interface UseSpeakerContext {
	readonly ctx: SpeakerContext;
	assign: (speakerId: number, name: string) => Promise<void>;
}

export function useSpeakerContext(
	getMeetingId: () => string | undefined,
	getSegments: () => TranscriptSegmentData[],
): UseSpeakerContext {
	let ctx = $state<SpeakerContext>(emptySpeakerContext());
	// Bumped on every load dispatch and on every successful rename; a resolved
	// load whose captured token no longer matches is stale and must be dropped.
	let genId = 0;
	let lastId: string | undefined;

	// Reload when diarization changes the set of clusters (not on every segment).
	const clusterSignature = $derived(clusterSignatureOf(getSegments()));

	async function load(id: string, gen: number): Promise<void> {
		const res = await commands.getMeetingSpeakers(id);
		if (gen !== genId) return; // superseded by a newer load, meeting switch, or rename
		if (res.status !== 'ok') {
			toast.error('Failed to load speaker names', { description: res.error });
			return;
		}
		ctx = {
			names: new Map(
				res.data.speakers
					.filter((s): s is { speaker_id: number; name: string } => s.name != null)
					.map((s) => [s.speaker_id, s.name]),
			),
			selfName: res.data.self_name ?? undefined,
			shortlist: res.data.shortlist,
		};
	}

	$effect(() => {
		const id = getMeetingId();
		// Track the cluster set so a diarization run refreshes names.
		void clusterSignature;
		genId += 1;
		const gen = genId;
		if (id !== lastId) {
			// New meeting: clear immediately so no prior-meeting names show while loading.
			ctx = emptySpeakerContext();
			lastId = id;
		}
		if (!id) return;
		void load(id, gen);
	});

	async function assign(speakerId: number, name: string): Promise<void> {
		const id = getMeetingId();
		if (!id) return;
		const res = await commands.setSpeakerName(id, speakerId, name);
		if (res.status !== 'ok') {
			toast.error('Failed to rename speaker', { description: res.error });
			return;
		}
		// Invalidate any in-flight load so it can't overwrite this rename, then
		// apply locally (avoids a refetch round-trip).
		genId += 1;
		const names = new Map(ctx.names);
		names.set(speakerId, name);
		ctx = { ...ctx, names };
	}

	return {
		get ctx() {
			return ctx;
		},
		assign,
	};
}
