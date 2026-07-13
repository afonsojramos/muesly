<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { Eye, EyeOff, Lock, Unlock, Plus, X } from '@lucide/svelte';

	import type { TranscriptModelProps } from '$lib/services/config';
	import * as Card from '$lib/components/ui/card';
	import * as Field from '$lib/components/ui/field';
	import * as InputGroup from '$lib/components/ui/input-group';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import WhisperModelManager from './WhisperModelManager.svelte';
	import ParakeetModelManager from './ParakeetModelManager.svelte';
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

	// svelte-ignore state_referenced_locally
	let apiKey = $state<string | null>(transcriptModelConfig.apiKey ?? null);
	let showApiKey = $state(false);
	let isApiKeyLocked = $state(true);
	// svelte-ignore state_referenced_locally
	let uiProvider = $state<TranscriptModelProps['provider']>(transcriptModelConfig.provider);

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

	// Keep the provider dropdown synced with external config changes.
	$effect(() => {
		uiProvider = transcriptModelConfig.provider;
	});
	$effect(() => {
		if (
			transcriptModelConfig.provider === 'localWhisper' ||
			transcriptModelConfig.provider === 'parakeet'
		) {
			apiKey = null;
		}
	});

	const providerItems = [
		{ value: 'parakeet', label: 'Parakeet — Fast, real-time' },
		{ value: 'localWhisper', label: 'Local Whisper — Best accuracy' },
	];

	const requiresApiKey = $derived(
		uiProvider === 'deepgram' ||
			uiProvider === 'elevenLabs' ||
			uiProvider === 'openai' ||
			uiProvider === 'groq',
	);

	async function fetchApiKey(provider: string): Promise<void> {
		try {
			apiKey = ((await invoke('api_get_transcript_api_key', { provider })) as string) || '';
		} catch (err) {
			console.error('Error fetching API key:', err);
			apiKey = null;
		}
	}

	const providerLabel = $derived(
		providerItems.find((item) => item.value === uiProvider)?.label ?? 'Select provider',
	);

	function handleProviderChange(value: string): void {
		const provider = (value ?? 'parakeet') as TranscriptModelProps['provider'];
		uiProvider = provider;
		if (provider !== 'localWhisper' && provider !== 'parakeet') {
			void fetchApiKey(provider);
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

	function handleParakeetSelect(modelName: string): void {
		setTranscriptModelConfig({ ...transcriptModelConfig, provider: 'parakeet', model: modelName });
		onModelSelect?.();
	}
</script>

<div class="flex flex-col gap-4">
	<Card.Root>
		<Card.Header>
			<Card.Title>Transcription Model</Card.Title>
			<Card.Description>
				Choose the engine that converts speech to text. Local models run entirely on your device.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			<Field.Field>
				<Field.FieldLabel for="transcript-provider">Transcript Model</Field.FieldLabel>
				<Select.Root type="single" value={uiProvider} onValueChange={handleProviderChange}>
					<Select.Trigger id="transcript-provider" class="w-full">
						{providerLabel}
					</Select.Trigger>
					<Select.Content>
						<Select.Group>
							{#each providerItems as item (item.value)}
								<Select.Item value={item.value} label={item.label}>{item.label}</Select.Item>
							{/each}
						</Select.Group>
					</Select.Content>
				</Select.Root>
				<Field.Description>
					{uiProvider === 'parakeet'
						? 'Best for low-latency live notes. Short phrases and specialist terms may need vocabulary corrections.'
						: 'Best for accents, longer context, and specialist terminology; it uses more processing time.'}
				</Field.Description>
			</Field.Field>

			{#if uiProvider === 'localWhisper'}
				<WhisperModelManager
					selectedModel={transcriptModelConfig.provider === 'localWhisper'
						? transcriptModelConfig.model
						: undefined}
					onModelSelect={handleWhisperSelect}
					autoSave={true}
				/>
			{:else if uiProvider === 'parakeet'}
				<ParakeetModelManager
					selectedModel={transcriptModelConfig.provider === 'parakeet'
						? transcriptModelConfig.model
						: undefined}
					onModelSelect={handleParakeetSelect}
					autoSave={true}
				/>
			{/if}

			{#if requiresApiKey}
				<Field.Field>
					<Field.FieldLabel for="transcript-api-key">API Key</Field.FieldLabel>
					<InputGroup.Root>
						<InputGroup.Input
							id="transcript-api-key"
							type={showApiKey ? 'text' : 'password'}
							value={apiKey ?? ''}
							disabled={isApiKeyLocked}
							oninput={(e) => (apiKey = e.currentTarget.value)}
							placeholder="Enter your API key"
						/>
						<InputGroup.Addon align="inline-end">
							<InputGroup.Button
								size="icon-xs"
								aria-label={isApiKeyLocked ? 'Unlock API key' : 'Lock API key'}
								onclick={() => (isApiKeyLocked = !isApiKeyLocked)}
							>
								{#if isApiKeyLocked}<Lock />{:else}<Unlock />{/if}
							</InputGroup.Button>
							<InputGroup.Button
								size="icon-xs"
								aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
								onclick={() => (showApiKey = !showApiKey)}
							>
								{#if showApiKey}<EyeOff />{:else}<Eye />{/if}
							</InputGroup.Button>
						</InputGroup.Addon>
					</InputGroup.Root>
				</Field.Field>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Custom vocabulary</Card.Title>
			<Card.Description>
				Add names, jargon, and acronyms in their preferred spelling. Whisper uses every preferred
				term as context; optional mishearings correct the output from either local engine.
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
