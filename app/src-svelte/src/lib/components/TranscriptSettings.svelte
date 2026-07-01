<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
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
		{ value: 'parakeet', label: '⚡ Parakeet (Recommended — Real-time / Accurate)' },
		{ value: 'localWhisper', label: '🏠 Local Whisper (High Accuracy)' },
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
			<Card.Title>Custom Vocabulary</Card.Title>
			<Card.Description>
				Fix words the transcriber mishears (proper nouns, jargon, acronyms). Matching is whole-word
				and case-insensitive.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-col gap-2">
				{#each config.customVocabulary as entry, i}
					<div class="flex items-center gap-2">
						<Input
							class="flex-1"
							value={entry.from}
							placeholder="Mishear (e.g. cubernetes)"
							oninput={(e) => {
								const updated = config.customVocabulary.map((v, idx) =>
									idx === i ? { ...v, from: e.currentTarget.value } : v,
								);
								config.setCustomVocabulary(updated);
							}}
						/>
						<span class="text-muted-foreground shrink-0 text-xs">→</span>
						<Input
							class="flex-1"
							value={entry.to}
							placeholder="Correction (e.g. Kubernetes)"
							oninput={(e) => {
								const updated = config.customVocabulary.map((v, idx) =>
									idx === i ? { ...v, to: e.currentTarget.value } : v,
								);
								config.setCustomVocabulary(updated);
							}}
						/>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Remove term"
							onclick={() => {
								const updated = config.customVocabulary.filter((_, idx) => idx !== i);
								config.setCustomVocabulary(updated);
							}}
						>
							<X />
						</Button>
					</div>
				{/each}
				<Button
					variant="outline"
					size="sm"
					class="self-start"
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
</div>
