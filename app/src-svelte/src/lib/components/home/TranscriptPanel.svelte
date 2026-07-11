<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import GlobeIcon from '@lucide/svelte/icons/globe';
	import { tick } from 'svelte';

	import type { TranscriptSegmentData } from '$lib/types';
	import { Button } from '$lib/components/ui/button';
	import * as Command from '$lib/components/ui/command';
	import * as Popover from '$lib/components/ui/popover';
	import * as Tooltip from '$lib/components/ui/tooltip';
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
			speaker: t.speaker,
		})),
	);

	// Inline transcription-language picker. Replaces the old full-page jump to
	// /settings: it reads/writes config.selectedLanguage, which persists to the DB
	// and syncs to the Rust transcription engine via set_language_preference.
	let langOpen = $state(false);
	let langTriggerRef = $state<HTMLButtonElement>(null!);

	function selectLanguage(code: string): void {
		config.setSelectedLanguage(code);
		langOpen = false;
		void tick().then(() => langTriggerRef?.focus());
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
				<Tooltip.Provider delayDuration={300}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="sm"
									class="text-muted-foreground hover:text-foreground"
									onclick={transcriptStore.copyTranscript}
									aria-label="Copy transcript"
								>
									<CopyIcon data-icon="inline-start" />
									<span class="hidden md:inline">Copy</span>
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>Copy Transcript</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			{/if}
			{#if config.transcriptModelConfig.provider === 'localWhisper'}
				<Popover.Root bind:open={langOpen}>
					<Popover.Trigger bind:ref={langTriggerRef}>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="sm"
								class="text-muted-foreground hover:text-foreground"
								role="combobox"
								aria-expanded={langOpen}
								aria-label="Choose transcription language"
							>
								<GlobeIcon data-icon="inline-start" />
								<span class="hidden md:inline">Language</span>
							</Button>
						{/snippet}
					</Popover.Trigger>
					<Popover.Content align="end" class="w-64 p-0">
						<Command.Root>
							<Command.Input placeholder="Search language" />
							<Command.List>
								<Command.Empty>No languages match.</Command.Empty>
								<Command.Group value="languages">
									{#each LANGUAGES as lang (lang.code)}
										{@const isSelected = lang.code === config.selectedLanguage}
										<Command.Item
											value={`${lang.name} ${lang.code}`}
											onSelect={() => selectLanguage(lang.code)}
										>
											<CheckIcon class={cn('text-brand', !isSelected && 'text-transparent')} />
											<span class={cn(isSelected && 'font-medium')}>{lang.name}</span>
										</Command.Item>
									{/each}
								</Command.Group>
							</Command.List>
						</Command.Root>
					</Popover.Content>
				</Popover.Root>
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
