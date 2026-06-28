<script lang="ts">
	import { Check, Copy, Globe } from '@lucide/svelte';

	import type { TranscriptSegmentData } from '$lib/types';
	import Button, { buttonVariants } from '$lib/ui/button.svelte';
	import Popover from '$lib/ui/popover.svelte';
	import VirtualizedTranscriptView from '$lib/components/VirtualizedTranscriptView.svelte';
	import { LANGUAGES } from '$lib/constants/languages';
	import { config } from '$lib/stores/config.svelte';
	import { recordingState } from '$lib/stores/recording-state.svelte';
	import { transcripts as transcriptStore } from '$lib/stores/transcript.svelte';
	import { cn } from '$lib/utils';

	interface Props {
		/** Stop-processing state for transcripts; derived from backend statuses. */
		isProcessingStop: boolean;
		isStopping: boolean;
		/** Render as a narrow side panel (full-width content) instead of the centered main surface. */
		compact?: boolean;
	}

	let { isProcessingStop, isStopping, compact = false }: Props = $props();

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

	// Inline transcription-language picker. Replaces the old full-page jump to
	// /settings: it reads/writes config.selectedLanguage, which persists to the DB
	// and syncs to the Rust transcription engine via set_language_preference.
	let langOpen = $state(false);
	let langQuery = $state('');
	const filteredLanguages = $derived.by(() => {
		const q = langQuery.trim().toLowerCase();
		if (!q) return LANGUAGES;
		return LANGUAGES.filter(
			(l) => l.name.toLowerCase().includes(q) || l.code.toLowerCase().includes(q)
		);
	});

	function selectLanguage(code: string): void {
		config.setSelectedLanguage(code);
		langOpen = false;
		langQuery = '';
	}
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
				<Popover bind:open={langOpen} placement="bottom-end" class="w-64 p-0">
					{#snippet trigger()}
						<span
							class={cn(
								buttonVariants({ variant: 'ghost', size: 'sm' }),
								'text-muted-foreground hover:text-foreground'
							)}
						>
							<Globe />
							<span class="hidden md:inline">Language</span>
							<span class="sr-only">Choose transcription language</span>
						</span>
					{/snippet}
					{#snippet children()}
						<div class="flex max-h-80 flex-col">
							<div class="border-b border-border p-2">
								<input
									bind:value={langQuery}
									placeholder="Search language"
									aria-label="Search language"
									class="w-full rounded-md bg-secondary px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
								/>
							</div>
							<div class="overflow-y-auto p-1">
								{#each filteredLanguages as lang (lang.code)}
									<button
										type="button"
										onclick={() => selectLanguage(lang.code)}
										class="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
									>
										<span class={lang.code === config.selectedLanguage ? 'font-medium' : ''}>
											{lang.name}
										</span>
										{#if lang.code === config.selectedLanguage}
											<Check class="size-4 shrink-0 text-accent" />
										{/if}
									</button>
								{:else}
									<div class="px-2 py-3 text-center text-sm text-muted-foreground">
										No languages match.
									</div>
								{/each}
							</div>
						</div>
					{/snippet}
				</Popover>
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
