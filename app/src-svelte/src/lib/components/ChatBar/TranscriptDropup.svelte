<script lang="ts">
	import CopyIcon from '@lucide/svelte/icons/copy';
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';

	import type { Transcript, TranscriptSegmentData } from '$lib/types';
	import { Analytics } from '$lib/analytics';
	import { toast } from '$lib/toast';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import TalkTimeBar from '$lib/components/MeetingDetails/TalkTimeBar.svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import {
		fetchSpeakerContext,
		transcriptMarkdownBody,
	} from '$lib/hooks/use-copy-operations.svelte';
	import { useSpeakerContext } from '$lib/hooks/use-speaker-context.svelte';
	import { transcripts as liveTranscripts } from '$lib/stores/transcript.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import RecordingStatusBar from '$lib/components/RecordingStatusBar.svelte';

	interface Props {
		meetingId: string | null;
		live?: boolean;
	}

	let { meetingId, live = false }: Props = $props();
	let savedTranscripts = $state<Transcript[]>([]);
	let loading = $state(false);
	// Bumped when a background job rewrites this meeting's transcript while the
	// drop-up is open, so the load below re-runs instead of serving stale rows.
	let refreshToken = $state(0);

	$effect(() => {
		void refreshToken;
		if (live || !meetingId) {
			savedTranscripts = [];
			loading = false;
			return;
		}
		const id = meetingId;
		savedTranscripts = [];
		loading = true;
		void invoke<{ transcripts: Transcript[] }>('api_get_meeting_transcripts', {
			meetingId: id,
			limit: 10000,
			offset: 0,
		})
			.then((response) => {
				if (meetingId === id) savedTranscripts = response.transcripts;
			})
			.catch((error) => console.error('Failed to load transcript drop-up:', error))
			.finally(() => {
				if (meetingId === id) loading = false;
			});
	});

	// Diarization and retranscription rewrite the transcript out from under an
	// open drop-up; both emit a completion event carrying the meeting id.
	$effect(() => {
		if (live || !meetingId) return;
		const id = meetingId;
		let disposed = false;
		const unlisteners: UnlistenFn[] = [];
		for (const event of ['diarization-complete', 'retranscription-complete']) {
			void listen<{ meeting_id?: string }>(event, (e) => {
				if (e.payload?.meeting_id === id) refreshToken++;
			}).then((unlisten) => {
				// The effect can be cleaned up before listen() resolves; unlisten then.
				if (disposed) unlisten();
				else unlisteners.push(unlisten);
			});
		}
		return () => {
			disposed = true;
			unlisteners.forEach((unlisten) => unlisten());
		};
	});

	const rows = $derived(live ? liveTranscripts.transcripts : savedTranscripts);
	const segments = $derived.by((): TranscriptSegmentData[] =>
		rows.map((row) => ({
			id: row.id,
			timestamp: row.audio_start_time ?? 0,
			endTime: row.audio_end_time,
			text: row.text,
			confidence: row.confidence,
			speaker: row.speaker,
			speaker_id: row.speaker_id,
		})),
	);

	// Named-speaker context (assigned names, self name, attendee shortlist) for
	// post-meeting transcripts; live transcripts have no diarized speakers yet.
	const speakers = useSpeakerContext(
		() => (live ? undefined : (meetingId ?? undefined)),
		() => segments,
	);

	async function copyTranscript(): Promise<void> {
		Analytics.trackButtonClick('copy_transcript', 'transcript_dropup');
		if (live) {
			liveTranscripts.copyTranscript();
			return;
		}
		// Fetch the naming context at copy time: the reactive `speakers.ctx` may
		// still be the empty placeholder right after the drop-up opens.
		const ctx = meetingId ? await fetchSpeakerContext(meetingId) : speakers.ctx;
		await navigator.clipboard.writeText(transcriptMarkdownBody(savedTranscripts, ctx));
		toast.success('Transcript copied to clipboard');
	}
</script>

<div class="flex h-[min(60vh,30rem)] min-h-64 flex-col overflow-hidden">
	<div class="flex items-center border-b border-border px-4 py-3">
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium">Transcript</span>
			{#if live && recordingState.isRecording}
				<RecordingStatusBar isPaused={recordingState.isPaused} compact />
			{/if}
		</div>
		<div class="ml-auto flex items-center gap-2">
			<span class="text-xs tabular-nums text-muted-foreground">
				{segments.length}
				{segments.length === 1 ? 'segment' : 'segments'}
			</span>
			<Tooltip.Provider delayDuration={300}>
				<Tooltip.Root>
					<Tooltip.Trigger>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="icon-sm"
								class="text-muted-foreground hover:text-foreground"
								disabled={segments.length === 0}
								aria-label="Copy transcript"
								onclick={() => void copyTranscript()}
							>
								<CopyIcon />
							</Button>
						{/snippet}
					</Tooltip.Trigger>
					<Tooltip.Content>Copy transcript</Tooltip.Content>
				</Tooltip.Root>
			</Tooltip.Provider>
		</div>
	</div>
	{#if loading}
		<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
			Loading transcript…
		</div>
	{:else if segments.length === 0}
		<div class="flex flex-1 items-center justify-center text-sm text-muted-foreground">
			No transcript yet
		</div>
	{:else}
		<!-- Talk-time breakdown: post-meeting only; hides itself when it carries
		     no signal (fewer than two speakers with timed speech). -->
		{#if !live && meetingId}
			<div class="flex-shrink-0 px-4 pt-2">
				<TalkTimeBar {meetingId} {segments} speakerContext={speakers.ctx} />
			</div>
		{/if}
		<div class="min-h-0 flex-1 overflow-hidden py-2">
			<VirtualizedTranscriptView
				{segments}
				isRecording={live && recordingState.isRecording}
				isPaused={recordingState.isPaused}
				isProcessing={false}
				isStopping={recordingState.isStopping}
				enableStreaming={live && recordingState.isRecording}
				showConfidence={true}
				showRecordingStatus={false}
				disableAutoScroll={!live}
				showSpeakers={!live && !!meetingId}
				speakerContext={speakers.ctx}
				onAssignSpeaker={!live && meetingId ? speakers.assign : undefined}
				onClearSpeaker={!live && meetingId ? speakers.clear : undefined}
			/>
		</div>
	{/if}
</div>
