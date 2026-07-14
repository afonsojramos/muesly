<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	import type { Transcript, TranscriptSegmentData } from '$lib/types';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import { transcripts as liveTranscripts } from '$lib/stores/transcript.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';

	interface Props {
		meetingId: string | null;
		live?: boolean;
	}

	let { meetingId, live = false }: Props = $props();
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
	<div class="flex items-center justify-between border-b border-border px-4 py-3">
		<span class="text-sm font-medium">Transcript</span>
		<span class="text-xs tabular-nums text-muted-foreground">
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
				disableAutoScroll={!live}
			/>
		</div>
	{/if}
</div>
