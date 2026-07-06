<script lang="ts" module>
	const BASIC_MODEL_NAMES = ['small', 'medium-q5_0', 'large-v3-q5_0', 'large-v3-turbo', 'large-v3'];

	const DISPLAY_NAMES: Record<string, string> = {
		small: 'Small',
		'medium-q5_0': 'Medium',
		'large-v3-q5_0': 'Large V3 Compressed',
		'large-v3-turbo': 'Large V3 Turbo',
		'large-v3': 'Large V3',
	};

	export function whisperDisplayName(modelName: string): string {
		return BASIC_MODEL_NAMES.includes(modelName)
			? (DISPLAY_NAMES[modelName] ?? modelName)
			: `Whisper ${modelName}`;
	}
</script>

<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import {
		formatFileSize,
		getModelIcon,
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
		onModelSelect?: (modelName: string) => void;
		class?: string;
		autoSave?: boolean;
	}

	let { selectedModel, onModelSelect, class: className = '', autoSave = false }: Props = $props();

	let models = $state<ModelInfo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	const downloadingModels = new SvelteSet<string>();
	const progressThrottle = new Map<string, { progress: number; timestamp: number }>();

	const basicModels = $derived(
		models
			.filter((m) => BASIC_MODEL_NAMES.includes(m.name))
			.sort((a, b) => BASIC_MODEL_NAMES.indexOf(a.name) - BASIC_MODEL_NAMES.indexOf(b.name)),
	);
	const advancedModels = $derived(models.filter((m) => !BASIC_MODEL_NAMES.includes(m.name)));

	function setModelStatus(modelName: string, status: ModelStatus): void {
		models = models.map((m) => (m.name === modelName ? { ...m, status } : m));
	}

	async function saveModelSelection(modelName: string): Promise<void> {
		try {
			await invoke('api_save_transcript_config', {
				provider: 'localWhisper',
				model: modelName,
				apiKey: null,
			});
		} catch (err) {
			console.error('Failed to save model selection:', err);
		}
	}

	async function downloadModel(modelName: string): Promise<void> {
		if (downloadingModels.has(modelName)) return;
		const displayName = whisperDisplayName(modelName);
		try {
			downloadingModels.add(modelName);
			setModelStatus(modelName, { Downloading: 0 });
			toast.info(`Downloading ${displayName}...`, {
				description: 'This may take a few minutes',
				duration: 5000,
			});
			await WhisperAPI.downloadModel(modelName);
		} catch (err) {
			console.error('Download failed:', err);
			downloadingModels.delete(modelName);
			setModelStatus(modelName, { Error: err instanceof Error ? err.message : 'Download failed' });
		}
	}

	async function cancelDownload(modelName: string): Promise<void> {
		try {
			await WhisperAPI.cancelDownload(modelName);
			downloadingModels.delete(modelName);
			setModelStatus(modelName, 'Missing');
			progressThrottle.delete(modelName);
			toast.info(`${whisperDisplayName(modelName)} download cancelled`, { duration: 3000 });
		} catch (err) {
			console.error('Failed to cancel download:', err);
			toast.error('Failed to cancel download', {
				description: err instanceof Error ? err.message : 'Unknown error',
			});
		}
	}

	async function selectModel(modelName: string): Promise<void> {
		onModelSelect?.(modelName);
		if (autoSave) await saveModelSelection(modelName);
		toast.success(`Switched to ${whisperDisplayName(modelName)}`, { duration: 3000 });
	}

	async function deleteModel(modelName: string): Promise<void> {
		const displayName = whisperDisplayName(modelName);
		try {
			await WhisperAPI.deleteCorruptedModel(modelName);
			models = await WhisperAPI.getAvailableModels();
			toast.success(`${displayName} deleted`, {
				description: 'Model removed to free up space',
				duration: 3000,
			});
			if (selectedModel === modelName) onModelSelect?.('');
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
				await WhisperAPI.init();
				models = await WhisperAPI.getAvailableModels();
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
			push(
				await listen<{ modelName: string; progress: number }>(
					'model-download-progress',
					(event) => {
						const { modelName, progress } = event.payload;
						const now = Date.now();
						const last = progressThrottle.get(modelName);
						const shouldUpdate =
							!last || now - last.timestamp > 300 || Math.abs(progress - last.progress) >= 5;
						if (shouldUpdate) {
							progressThrottle.set(modelName, { progress, timestamp: now });
							setModelStatus(modelName, { Downloading: progress });
						}
					},
				),
			);
			push(
				await listen<{ modelName: string }>('model-download-complete', (event) => {
					const { modelName } = event.payload;
					const model = models.find((m) => m.name === modelName);
					setModelStatus(modelName, 'Available');
					downloadingModels.delete(modelName);
					progressThrottle.delete(modelName);
					toast.success(
						`${getModelIcon(model?.accuracy ?? 'Good')} ${whisperDisplayName(modelName)} ready!`,
						{
							description: 'Model downloaded and ready to use',
							duration: 4000,
						},
					);
					onModelSelect?.(modelName);
					if (autoSave) void saveModelSelection(modelName);
				}),
			);
			push(
				await listen<{ modelName: string; error: string }>('model-download-error', (event) => {
					const { modelName, error: errMsg } = event.payload;
					setModelStatus(modelName, { Error: errMsg });
					downloadingModels.delete(modelName);
					progressThrottle.delete(modelName);
					toast.error(`Failed to download ${whisperDisplayName(modelName)}`, {
						description: errMsg,
						duration: 6000,
					});
				}),
			);
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
	function whisperCardDisplay(model: ModelInfo) {
		const { status, downloadProgress } = normalizeModelStatus(model.status);
		return {
			title: whisperDisplayName(model.name),
			icon: getModelIcon(model.accuracy),
			tagline: getModelTagline(model.name, model.speed, model.accuracy),
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
			{#each basicModels as model (model.name)}
				<ModelCard
					{...whisperCardDisplay(model)}
					isSelected={selectedModel === model.name}
					isRecommended={model.name === 'base'}
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
					<Accordion.Trigger>Advanced Models</Accordion.Trigger>
					<Accordion.Content>
						<div class="flex flex-col gap-3 pt-4">
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
				Using {whisperDisplayName(selectedModel)} for transcription
			</div>
		{/if}
	</div>
{/if}
