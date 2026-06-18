<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { Eye, EyeOff, Lock, Unlock, Plus, X } from '@lucide/svelte';

	import type { TranscriptModelProps } from '$lib/services/config';
	import Label from '$lib/ui/label.svelte';
	import Input from '$lib/ui/input.svelte';
	import Button from '$lib/ui/button.svelte';
	import Select from '$lib/ui/select.svelte';
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
		if (transcriptModelConfig.provider === 'localWhisper' || transcriptModelConfig.provider === 'parakeet') {
			apiKey = null;
		}
	});

	const providerItems = [
		{ value: 'parakeet', label: '⚡ Parakeet (Recommended — Real-time / Accurate)' },
		{ value: 'localWhisper', label: '🏠 Local Whisper (High Accuracy)' }
	];

	const requiresApiKey = $derived(
		uiProvider === 'deepgram' ||
			uiProvider === 'elevenLabs' ||
			uiProvider === 'openai' ||
			uiProvider === 'groq'
	);

	async function fetchApiKey(provider: string): Promise<void> {
		try {
			apiKey = ((await invoke('api_get_transcript_api_key', { provider })) as string) || '';
		} catch (err) {
			console.error('Error fetching API key:', err);
			apiKey = null;
		}
	}

	function handleProviderChange(value: string[]): void {
		const provider = (value[0] ?? 'parakeet') as TranscriptModelProps['provider'];
		uiProvider = provider;
		if (provider !== 'localWhisper' && provider !== 'parakeet') {
			void fetchApiKey(provider);
		}
	}

	function handleWhisperSelect(modelName: string): void {
		setTranscriptModelConfig({ ...transcriptModelConfig, provider: 'localWhisper', model: modelName });
		onModelSelect?.();
	}

	function handleParakeetSelect(modelName: string): void {
		setTranscriptModelConfig({ ...transcriptModelConfig, provider: 'parakeet', model: modelName });
		onModelSelect?.();
	}
</script>

<div class="space-y-4 pb-6">
	<div>
		<Label class="mb-1 block">Transcript Model</Label>
		<div class="mx-1">
			<Select
				items={providerItems}
				value={[uiProvider]}
				placeholder="Select provider"
				onValueChange={handleProviderChange}
			/>
		</div>
	</div>

	{#if uiProvider === 'localWhisper'}
		<div class="mt-6">
			<WhisperModelManager
				selectedModel={transcriptModelConfig.provider === 'localWhisper'
					? transcriptModelConfig.model
					: undefined}
				onModelSelect={handleWhisperSelect}
				autoSave={true}
			/>
		</div>
	{:else if uiProvider === 'parakeet'}
		<div class="mt-6">
			<ParakeetModelManager
				selectedModel={transcriptModelConfig.provider === 'parakeet'
					? transcriptModelConfig.model
					: undefined}
				onModelSelect={handleParakeetSelect}
				autoSave={true}
			/>
		</div>
	{/if}

	{#if requiresApiKey}
		<div>
			<Label class="mb-1 block">API Key</Label>
			<div class="relative mx-1">
				<Input
					type={showApiKey ? 'text' : 'password'}
					class="pr-24"
					value={apiKey ?? ''}
					disabled={isApiKeyLocked}
					oninput={(e) => (apiKey = e.currentTarget.value)}
					placeholder="Enter your API key"
				/>
				<div class="absolute inset-y-0 right-0 flex items-center pr-1">
					<Button variant="ghost" size="icon" onclick={() => (isApiKeyLocked = !isApiKeyLocked)}>
						{#if isApiKeyLocked}<Lock class="size-4" />{:else}<Unlock class="size-4" />{/if}
					</Button>
					<Button variant="ghost" size="icon" onclick={() => (showApiKey = !showApiKey)}>
						{#if showApiKey}<EyeOff class="size-4" />{:else}<Eye class="size-4" />{/if}
					</Button>
				</div>
			</div>
		</div>
	{/if}

	<div>
		<Label class="mb-1 block">Custom Vocabulary</Label>
		<p class="text-muted-foreground mx-1 mb-2 text-xs">
			Fix words the transcriber mishears (proper nouns, jargon, acronyms). Matching is whole-word
			and case-insensitive.
		</p>
		<div class="mx-1 space-y-2">
			{#each config.customVocabulary as entry, i}
				<div class="flex items-center gap-2">
					<Input
						class="flex-1"
						value={entry.from}
						placeholder="Mishear (e.g. cubernetes)"
						oninput={(e) => {
							const updated = config.customVocabulary.map((v, idx) =>
								idx === i ? { ...v, from: e.currentTarget.value } : v
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
								idx === i ? { ...v, to: e.currentTarget.value } : v
							);
							config.setCustomVocabulary(updated);
						}}
					/>
					<Button
						variant="ghost"
						size="icon"
						onclick={() => {
							const updated = config.customVocabulary.filter((_, idx) => idx !== i);
							config.setCustomVocabulary(updated);
						}}
					>
						<X class="size-4" />
					</Button>
				</div>
			{/each}
			<Button
				variant="outline"
				size="sm"
				onclick={() => {
					config.setCustomVocabulary([...config.customVocabulary, { from: '', to: '' }]);
				}}
			>
				<Plus class="mr-1 size-4" />
				Add term
			</Button>
		</div>
	</div>
</div>
