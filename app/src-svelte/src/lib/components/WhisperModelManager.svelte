<script lang="ts" module>
	const DISPLAY_NAMES: Record<string, string> = {
		tiny: 'Whisper Tiny',
		'tiny-q5_1': 'Whisper Tiny (compressed)',
		base: 'Whisper Base',
		'base-q5_1': 'Whisper Base (compressed)',
		small: 'Whisper Small',
		'small-q5_1': 'Whisper Small (compressed)',
		medium: 'Whisper Medium',
		'medium-q5_0': 'Whisper Medium (compressed)',
		'large-v3-turbo-q5_0': 'Whisper Large V3 Turbo (compressed)',
		'large-v3-q5_0': 'Whisper Large V3 (compressed)',
		'large-v3-turbo': 'Whisper Large V3 Turbo',
		'large-v3': 'Whisper Large V3',
		'parakeet-tdt-0.6b-v3-int8': 'Parakeet V3',
	};

	export function whisperDisplayName(modelName: string): string {
		return DISPLAY_NAMES[modelName] ?? `Whisper ${modelName}`;
	}

	export type TranscriptionProvider = 'automatic' | 'localWhisper' | 'parakeet';

	/** Providers are inferred from the model name: the two engines' catalogs
	 *  use disjoint, stable naming. */
	export function providerForModel(modelName: string): TranscriptionProvider {
		if (modelName === 'automatic') return 'automatic';
		return modelName.startsWith('parakeet') ? 'parakeet' : 'localWhisper';
	}
</script>

<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { AudioWaveform, Box, Gauge, WandSparkles, Zap } from '@lucide/svelte';

	import {
		formatFileSize,
		getModelPerformanceBadge,
		getModelTagline,
		isQuantizedModel,
		WhisperAPI,
		type ModelInfo,
		type ModelStatus,
	} from '$lib/ai/whisper';
	import { normalizeModelStatus } from '$lib/model-status';
	import * as Accordion from '$lib/components/ui/accordion';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Alert from '$lib/components/ui/alert';
	import ModelCard from './ModelCard.svelte';
	import { toast } from '$lib/toast';
	import { cn } from '$lib/utils';

	interface Props {
		selectedModel?: string;
		onModelSelect?: (modelName: string, provider?: TranscriptionProvider) => void;
		class?: string;
		autoSave?: boolean;
	}

	/** The fast multilingual alternative surfaced as the "Fastest" profile. */
	const PARAKEET_MODEL = 'parakeet-tdt-0.6b-v3-int8';
	type AutomaticResolution = { provider: string; model: string; reason: string };

	let { selectedModel, onModelSelect, class: className = '', autoSave = false }: Props = $props();

	let models = $state<ModelInfo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let recommendedModel = $state('base-q5_1');
	let automaticResolution = $state<AutomaticResolution | null>(null);
	const downloadingModels = new SvelteSet<string>();
	const progressThrottle = new Map<string, { progress: number; timestamp: number }>();

	const fasterModel = $derived(
		recommendedModel === 'large-v3-turbo-q5_0'
			? 'small-q5_1'
			: recommendedModel === 'small-q5_1'
				? 'base-q5_1'
				: 'tiny-q5_1',
	);
	const profileDefinitions = $derived([
		{
			modelName: recommendedModel,
			title: 'Recommended',
			icon: WandSparkles,
			tagline: 'Best balance for this computer',
			recommended: false,
		},
		{
			modelName: fasterModel,
			title: 'Faster',
			icon: Gauge,
			tagline: 'Lower memory use and quicker results',
			recommended: false,
		},
		{
			modelName: 'large-v3-q5_0',
			title: 'Highest quality',
			icon: AudioWaveform,
			tagline: 'Best for difficult audio and important meetings',
			recommended: false,
		},
		{
			modelName: PARAKEET_MODEL,
			title: 'Fastest',
			icon: Zap,
			tagline: 'Very fast captions in 25 European languages',
			recommended: false,
		},
	]);
	const profileCards = $derived(
		profileDefinitions.flatMap((profile) => {
			const model = models.find((candidate) => candidate.name === profile.modelName);
			return model ? [{ profile, model }] : [];
		}),
	);
	const advancedModels = $derived(
		models.filter(
			(model) =>
				!profileDefinitions.some((profile) => profile.modelName === model.name) &&
				(model.status === 'Available' || model.name === selectedModel),
		),
	);
	const selectedProfile = $derived(
		profileDefinitions.find((profile) => profile.modelName === selectedModel),
	);

	function modelDisplayName(modelName: string): string {
		const profile = profileDefinitions.find((candidate) => candidate.modelName === modelName);
		return profile ? `${profile.title} model` : whisperDisplayName(modelName);
	}

	function setModelStatus(modelName: string, status: ModelStatus): void {
		models = models.map((m) => (m.name === modelName ? { ...m, status } : m));
	}

	async function saveModelSelection(modelName: string): Promise<void> {
		try {
			await invoke('api_save_transcript_config', {
				provider: providerForModel(modelName),
				model: modelName,
				apiKey: null,
			});
		} catch (err) {
			console.error('Failed to save model selection:', err);
		}
	}

	const automaticTagline = $derived(
		automaticResolution
			? `Currently ${whisperDisplayName(automaticResolution.model)} · ${automaticResolution.reason}`
			: 'Chooses the best downloaded model when each transcription starts',
	);

	/** All downloaded models across both engines, Parakeet mapped into the
	 *  shared ModelInfo card shape. */
	async function fetchAllModels(): Promise<ModelInfo[]> {
		const whisper = await WhisperAPI.getAvailableModels();
		try {
			const parakeet = await invoke<
				Array<{ name: string; path: string; size_mb: number; status: ModelStatus }>
			>('parakeet_get_available_models');
			return whisper.concat(
				parakeet.map((m) => ({
					name: m.name,
					path: m.path,
					size_mb: m.size_mb,
					accuracy: 'Good' as const,
					speed: 'Very Fast' as const,
					status: m.status,
					description:
						'Parakeet v3: very fast multilingual captions on CPU. No manual language forcing, translation, confidence score, or vocabulary prompting.',
				})),
			);
		} catch (err) {
			console.error('Failed to fetch Parakeet models:', err);
			return whisper;
		}
	}

	async function downloadModel(modelName: string): Promise<void> {
		if (downloadingModels.has(modelName)) return;
		const displayName = modelDisplayName(modelName);
		try {
			downloadingModels.add(modelName);
			setModelStatus(modelName, { Downloading: 0 });
			toast.info(`Downloading ${displayName}...`, {
				description: 'This may take a few minutes',
				duration: 5000,
			});
			if (providerForModel(modelName) === 'parakeet') {
				await invoke('parakeet_download_model', { modelName });
			} else {
				await WhisperAPI.downloadModel(modelName);
			}
		} catch (err) {
			console.error('Download failed:', err);
			downloadingModels.delete(modelName);
			setModelStatus(modelName, { Error: err instanceof Error ? err.message : 'Download failed' });
		}
	}

	async function cancelDownload(modelName: string): Promise<void> {
		try {
			if (providerForModel(modelName) === 'parakeet') {
				await invoke('parakeet_cancel_download', { modelName });
			} else {
				await WhisperAPI.cancelDownload(modelName);
			}
			downloadingModels.delete(modelName);
			setModelStatus(modelName, 'Missing');
			progressThrottle.delete(modelName);
			toast.info(`${modelDisplayName(modelName)} download cancelled`, { duration: 3000 });
		} catch (err) {
			console.error('Failed to cancel download:', err);
			toast.error('Failed to cancel download', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		}
	}

	async function selectModel(modelName: string): Promise<void> {
		onModelSelect?.(modelName, providerForModel(modelName));
		if (autoSave) await saveModelSelection(modelName);
		toast.success(`Switched to ${modelDisplayName(modelName)}`, { duration: 3000 });
	}

	async function deleteModel(modelName: string): Promise<void> {
		const displayName = modelDisplayName(modelName);
		try {
			if (providerForModel(modelName) === 'parakeet') {
				await invoke('parakeet_delete_corrupted_model', { modelName });
			} else {
				await WhisperAPI.deleteCorruptedModel(modelName);
			}
			models = await fetchAllModels();
			automaticResolution = await invoke<AutomaticResolution>(
				'get_automatic_transcription_model',
			).catch(() => null);
			toast.success(`${displayName} deleted`, {
				description: 'Model removed to free up space',
				duration: 3000,
			});
			if (selectedModel === modelName) {
				onModelSelect?.('automatic', 'automatic');
				if (autoSave) await saveModelSelection('automatic');
			}
		} catch (err) {
			console.error('Failed to delete model:', err);
			toast.error(`Failed to delete ${displayName}`, {
				description: err instanceof Error ? err.message : 'Delete failed',
			});
		}
	}

	onMount(() => {
		(async () => {
			try {
				loading = true;
				recommendedModel = await invoke<string>('whisper_get_recommended_model').catch(
					() => recommendedModel,
				);
				await WhisperAPI.init();
				await invoke('parakeet_init').catch((err) => {
					console.error('Failed to initialize Parakeet:', err);
				});
				models = await fetchAllModels();
				automaticResolution = await invoke<AutomaticResolution>(
					'get_automatic_transcription_model',
				).catch(() => null);
			} catch (err) {
				console.error('Failed to initialize Whisper:', err);
				error = err instanceof Error ? err.message : 'Failed to load models';
				toast.error('Failed to load transcription models', {
					description: err instanceof Error ? err.message : 'Unknown error',
				});
			} finally {
				loading = false;
			}
		})();

		const unsubscribers: UnlistenFn[] = [];
		let cancelled = false;
		const push = (fn: UnlistenFn) => (cancelled ? fn() : unsubscribers.push(fn));

		(async () => {
			const onProgress = (event: { payload: { modelName: string; progress: number } }) => {
				const { modelName, progress } = event.payload;
				const now = Date.now();
				const last = progressThrottle.get(modelName);
				const shouldUpdate =
					!last || now - last.timestamp > 300 || Math.abs(progress - last.progress) >= 5;
				if (shouldUpdate) {
					progressThrottle.set(modelName, { progress, timestamp: now });
					setModelStatus(modelName, { Downloading: progress });
				}
			};
			const onComplete = (event: { payload: { modelName: string } }) => {
				const { modelName } = event.payload;
				setModelStatus(modelName, 'Available');
				downloadingModels.delete(modelName);
				progressThrottle.delete(modelName);
				void invoke<NonNullable<typeof automaticResolution>>('get_automatic_transcription_model')
					.then((resolution) => (automaticResolution = resolution))
					.catch(() => {});
				toast.success(`${modelDisplayName(modelName)} ready`, {
					description: 'Model downloaded and ready to use',
					duration: 4000,
				});
				if (selectedModel !== 'automatic') {
					onModelSelect?.(modelName, providerForModel(modelName));
					if (autoSave) void saveModelSelection(modelName);
				}
			};
			const onError = (event: { payload: { modelName: string; error: string } }) => {
				const { modelName, error: errMsg } = event.payload;
				setModelStatus(modelName, { Error: errMsg });
				downloadingModels.delete(modelName);
				progressThrottle.delete(modelName);
				toast.error(`Failed to download ${modelDisplayName(modelName)}`, {
					description: errMsg,
					duration: 6000,
				});
			};
			// Both engines emit the same payload shapes on their own event names.
			push(await listen('model-download-progress', onProgress));
			push(await listen('parakeet-model-download-progress', onProgress));
			push(await listen('model-download-complete', onComplete));
			push(await listen('parakeet-model-download-complete', onComplete));
			push(await listen('model-download-error', onError));
			push(await listen('parakeet-model-download-error', onError));
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});

	function perfBadgeFor(modelName: string): { label: string; class: string } | undefined {
		if (!isQuantizedModel(modelName)) return undefined;
		const badge = getModelPerformanceBadge(modelName);
		const cls =
			badge.color === 'green'
				? 'bg-success/10 text-success'
				: badge.color === 'orange'
					? 'bg-warning/10 text-warning'
					: 'bg-secondary text-muted-foreground';
		return { label: badge.label, class: cls };
	}

	// Map a Whisper model to the shared ModelCard's display props.
	function whisperCardDisplay(model: ModelInfo, profile?: (typeof profileDefinitions)[number]) {
		const { status, downloadProgress } = normalizeModelStatus(model.status);
		return {
			title: profile?.title ?? whisperDisplayName(model.name),
			icon: profile?.icon ?? Box,
			tagline: profile?.tagline ?? getModelTagline(model.name, model.speed, model.accuracy),
			sizeLabel: formatFileSize(model.size_mb),
			accuracyLabel: `${model.accuracy} accuracy`,
			speedLabel: `${model.speed} processing`,
			perfBadge: perfBadgeFor(model.name),
			status,
			downloadProgress,
			progressLabel:
				downloadProgress !== null && model.size_mb
					? `${formatFileSize((model.size_mb * downloadProgress) / 100)} / ${formatFileSize(model.size_mb)}`
					: undefined,
		};
	}
</script>

{#if loading}
	<div class={cn('flex flex-col gap-3', className)}>
		<Skeleton class="h-20 rounded-lg" />
		<Skeleton class="h-20 rounded-lg" />
		<Skeleton class="h-20 rounded-lg" />
	</div>
{:else if error}
	<Alert.Root variant="destructive" class={className}>
		<Alert.Title>Failed to load models</Alert.Title>
		<Alert.Description>{error}</Alert.Description>
	</Alert.Root>
{:else}
	<div class={cn('flex flex-col gap-3', className)}>
		<div class="flex flex-col gap-3">
			<ModelCard
				title="Automatic"
				icon={WandSparkles}
				tagline={automaticTagline}
				isSelected={selectedModel === 'automatic'}
				isRecommended={true}
				status={automaticResolution ? 'available' : 'missing'}
				onSelect={() => selectModel('automatic')}
				onDownload={() => downloadModel(recommendedModel)}
			/>
			{#each profileCards as { profile, model } (profile.title)}
				<ModelCard
					{...whisperCardDisplay(model, profile)}
					isSelected={selectedModel === model.name}
					isRecommended={profile.recommended}
					onSelect={() => model.status === 'Available' && selectModel(model.name)}
					onDownload={() => downloadModel(model.name)}
					onCancel={() => cancelDownload(model.name)}
					onDelete={() => deleteModel(model.name)}
				/>
			{/each}
		</div>

		{#if advancedModels.length > 0}
			<Accordion.Root type="single">
				<Accordion.Item value="advanced-models">
					<Accordion.Trigger>Advanced models</Accordion.Trigger>
					<Accordion.Content>
						<div class="flex flex-col gap-3 pt-3">
							<p class="text-pretty text-sm text-muted-foreground">
								Downloaded and legacy models remain available here.
							</p>
							{#each advancedModels as model (model.name)}
								<ModelCard
									{...whisperCardDisplay(model)}
									isSelected={selectedModel === model.name}
									isRecommended={false}
									onSelect={() => model.status === 'Available' && selectModel(model.name)}
									onDownload={() => downloadModel(model.name)}
									onCancel={() => cancelDownload(model.name)}
									onDelete={() => deleteModel(model.name)}
								/>
							{/each}
						</div>
					</Accordion.Content>
				</Accordion.Item>
			</Accordion.Root>
		{/if}

		{#if selectedModel}
			<div in:fly={{ y: -5 }} class="pt-2 text-center text-xs text-muted-foreground">
				{#if selectedModel === 'automatic'}
					Automatic will choose once when each transcription starts
				{:else}
					Using {selectedProfile?.title ?? whisperDisplayName(selectedModel)} for transcription
				{/if}
			</div>
		{/if}
	</div>
{/if}
