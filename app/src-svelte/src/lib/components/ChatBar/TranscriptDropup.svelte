<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { scale } from 'svelte/transition';
	import Play from '@lucide/svelte/icons/play';

	import type { Transcript, TranscriptSegmentData } from '$lib/types';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import { transcripts as liveTranscripts } from '$lib/stores/transcript.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { Button } from '$lib/components/ui/button';
	import RecordingStatusBar from '$lib/components/RecordingStatusBar.svelte';

	interface Props {
		meetingId: string | null;
		live?: boolean;
		onResume?: () => void | Promise<void>;
	}

	let { meetingId, live = false, onResume }: Props = $props();
	let savedTranscripts = $state<Transcript[]>([]);
	let loading = $state(false);

	$effect(() => {
		if (live || !meetingId) return;
		const id = meetingId;
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
</script>

<div class="flex h-[min(60vh,30rem)] min-h-64 flex-col overflow-hidden">
	<div class="flex items-center border-b border-border px-4 py-3">
		<div class="flex items-center gap-3">
			<span class="text-sm font-medium">Transcript</span>
			{#if live && recordingState.isRecording}
				<RecordingStatusBar isPaused={recordingState.isPaused} compact />
			{/if}
		</div>
		<span class="ml-auto text-xs tabular-nums text-muted-foreground">
			{segments.length}
			{segments.length === 1 ? 'segment' : 'segments'}
		</span>
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
			/>
		</div>
	{/if}
	{#if recordingState.isRecording}
		<div class="flex shrink-0 border-t border-border p-2">
			<div class="origin-bottom-left" in:scale={{ start: 0.25, duration: 220 }}>
				<Button variant="brand" size="sm" onclick={() => void onResume?.()}>
					<Play data-icon="inline-start" fill="currentColor" />
					Resume recording
				</Button>
			</div>
		</div>
	{/if}
</div>
