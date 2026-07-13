<script lang="ts">
	import { onMount } from 'svelte';
	import { Plus, X } from '@lucide/svelte';

	import type { TranscriptModelProps } from '$lib/services/config';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import WhisperModelManager from './WhisperModelManager.svelte';
	import { config } from '$lib/stores/config.svelte';
	import { commands } from '$lib/bindings';
	import { Switch } from '$lib/components/ui/switch';
	import { toast } from '$lib/toast';

	interface Props {
		transcriptModelConfig: TranscriptModelProps;
		setTranscriptModelConfig: (config: TranscriptModelProps) => void;
		onModelSelect?: () => void;
	}

	let { transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: Props = $props();

	// Post-meeting quality pass: batch re-transcription of the saved audio.
	let qualityPassEnabled = $state(false);
	onMount(() => {
		void (async () => {
			const res = await commands.getPostMeetingQualityPassEnabled();
			if (res.status === 'ok') qualityPassEnabled = res.data;
		})();
	});
	async function toggleQualityPass(enabled: boolean): Promise<void> {
		qualityPassEnabled = enabled;
		const res = await commands.setPostMeetingQualityPassEnabled(enabled);
		if (res.status === 'error') {
			qualityPassEnabled = !enabled;
			toast.error('Failed to update quality pass setting', { description: res.error });
		}
	}

	function handleWhisperSelect(modelName: string): void {
		setTranscriptModelConfig({
			...transcriptModelConfig,
			provider: 'localWhisper',
			model: modelName,
		});
		onModelSelect?.();
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title class="text-balance">Transcription quality</Card.Title>
			<Card.Description>
				Speech stays on your device. Muesly recommends the best profile for this computer.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<WhisperModelManager
				selectedModel={transcriptModelConfig.model}
				onModelSelect={handleWhisperSelect}
				autoSave={true}
			/>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Custom vocabulary</Card.Title>
			<Card.Description>
				Add names, jargon, and acronyms in their preferred spelling. Whisper uses every preferred
				term as context; optional mishearings correct common recognition mistakes.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-col gap-3">
				{#if config.customVocabulary.length === 0}
					<p class="text-pretty rounded-lg bg-muted/40 px-3 py-2.5 text-sm text-muted-foreground">
						No preferred terms yet. Add the words that matter in your meetings.
					</p>
				{/if}
				{#each config.customVocabulary as entry, i}
					<div
						class="grid grid-cols-[minmax(0,1fr)_2.5rem] items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.5rem]"
					>
						<Field.Field class="col-span-2 sm:col-span-1">
							<Field.FieldLabel for={`vocabulary-term-${i}`}>Preferred term</Field.FieldLabel>
							<Input
								id={`vocabulary-term-${i}`}
								value={entry.to}
								placeholder="Kubernetes"
								oninput={(e) => {
									const updated = config.customVocabulary.map((v, idx) =>
										idx === i ? { ...v, to: e.currentTarget.value } : v,
									);
									config.setCustomVocabulary(updated);
								}}
							/>
						</Field.Field>
						<Field.Field>
							<Field.FieldLabel for={`vocabulary-aliases-${i}`}>Misheard as</Field.FieldLabel>
							<Input
								id={`vocabulary-aliases-${i}`}
								value={entry.from}
								placeholder="cubernetes, cooper netties"
								oninput={(e) => {
									const updated = config.customVocabulary.map((v, idx) =>
										idx === i ? { ...v, from: e.currentTarget.value } : v,
									);
									config.setCustomVocabulary(updated);
								}}
							/>
						</Field.Field>
						<Button
							variant="ghost"
							size="icon"
							class="h-10 w-10 text-muted-foreground transition-transform active:scale-[0.96] hover:text-destructive"
							aria-label="Remove term"
							onclick={() => {
								const updated = config.customVocabulary.filter((_, idx) => idx !== i);
								config.setCustomVocabulary(updated);
							}}
						>
							<X data-icon />
						</Button>
					</div>
				{/each}
				<p class="text-pretty text-xs text-muted-foreground">
					Separate multiple mishearings with commas. Matching ignores case, respects word
					boundaries, and prefers the longest matching phrase.
				</p>
				<Button
					variant="outline"
					size="sm"
					class="h-10 self-start transition-transform active:scale-[0.96]"
					onclick={() => {
						config.setCustomVocabulary([...config.customVocabulary, { from: '', to: '' }]);
					}}
				>
					<Plus data-icon="inline-start" />
					Add term
				</Button>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header class="flex-row items-center justify-between gap-4 space-y-0">
			<div>
				<Card.Title>Post-meeting quality pass</Card.Title>
				<Card.Description>
					After each meeting, re-transcribe the full recording with merged context for higher
					accuracy while preserving microphone/system attribution from the live timeline. Local
					models only; adds processing time after the recording stops. Off by default.
				</Card.Description>
			</div>
			<Switch checked={qualityPassEnabled} onCheckedChange={toggleQualityPass} />
		</Card.Header>
	</Card.Root>
</div>
