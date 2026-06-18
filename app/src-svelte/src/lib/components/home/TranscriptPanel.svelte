<script lang="ts">
	import { Copy, Globe } from '@lucide/svelte';

	import type { TranscriptSegmentData } from '$lib/types';
	import Button from '$lib/ui/button.svelte';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { transcripts as transcriptStore } from '$lib/stores/transcript.svelte';
	import type { ModalType } from '$lib/hooks/use-modal-state.svelte';

	interface Props {
		/** Stop-processing state for transcripts; derived from backend statuses. */
		isProcessingStop: boolean;
		isStopping: boolean;
		showModal: (name: ModalType, message?: string) => void;
		/** Render as a narrow side panel (full-width content) instead of the centered main surface. */
		compact?: boolean;
	}

	let { isProcessingStop, isStopping, showModal, compact = false }: Props = $props();

	const segments = $derived.by((): TranscriptSegmentData[] =>
		transcriptStore.transcripts.map((t) => ({
			id: t.id,
			timestamp: t.audio_start_time ?? 0,
			endTime: t.audio_end_time,
			text: t.text,
			confidence: t.confidence,
			speaker: t.speaker
		}))
	);
</script>

<!-- Bounded flex column: the header is fixed and the transcript area is the only
     flexible region, so VirtualizedTranscriptView's own scroll container (and its
     auto-scroll hook) is the element that actually scrolls. -->
<div class="flex h-full w-full flex-col bg-background">
	<div
		data-tauri-drag-region="deep"
		class="flex-shrink-0 bg-background/80 px-6 py-3 backdrop-blur-sm"
	>
		<div class="flex items-center justify-end gap-1">
			{#if transcriptStore.transcripts.length > 0}
				<Button
					variant="ghost"
					size="sm"
					class="text-muted-foreground hover:text-foreground"
					onclick={transcriptStore.copyTranscript}
					aria-label="Copy transcript"
					tooltip="Copy Transcript"
				>
					<Copy />
					<span class="hidden md:inline">Copy</span>
				</Button>
			{/if}
			{#if config.transcriptModelConfig.provider === 'localWhisper'}
				<Button
					variant="ghost"
					size="sm"
					class="text-muted-foreground hover:text-foreground"
					onclick={() => showModal('languageSettings')}
					aria-label="Language"
					tooltip="Language"
				>
					<Globe />
					<span class="hidden md:inline">Language</span>
				</Button>
			{/if}
		</div>
	</div>

	<div class="flex min-h-0 flex-1 justify-center overflow-hidden pb-4">
		<div class={compact ? 'h-full w-full' : 'h-full w-2/3 max-w-[750px]'}>
			<VirtualizedTranscriptView
				{segments}
				isRecording={recordingState.isRecording}
				isPaused={recordingState.isPaused}
				isProcessing={isProcessingStop}
				{isStopping}
				enableStreaming={recordingState.isRecording}
				showConfidence={true}
			/>
		</div>
	</div>
</div>
