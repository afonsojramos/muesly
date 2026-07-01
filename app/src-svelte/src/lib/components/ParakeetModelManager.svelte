<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { fly } from 'svelte/transition';
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import {
		getModelDisplayName,
		ParakeetAPI,
		type ParakeetModelInfo,
		type ModelStatus,
	} from '$lib/ai/parakeet';
	import ParakeetModelCard from './ParakeetModelCard.svelte';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Alert from '$lib/components/ui/alert';
	import { toast } from '$lib/toast';
	import { cn } from '$lib/utils';

	const RECOMMENDED = 'parakeet-tdt-0.6b-v3-int8';

	interface Props {
		selectedModel?: string;
		onModelSelect?: (modelName: string) => void;
		class?: string;
		autoSave?: boolean;
	}

	let { selectedModel, onModelSelect, class: className = '', autoSave = false }: Props = $props();

	let models = $state<ParakeetModelInfo[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	const downloadingModels = new SvelteSet<string>();

	const recommendedModel = $derived(models.find((m) => m.name === RECOMMENDED));
	const otherModels = $derived(models.filter((m) => m.name !== RECOMMENDED));

	function setModelStatus(modelName: string, status: ModelStatus): void {
		models = models.map((m) => (m.name === modelName ? { ...m, status } : m));
	}

	async function saveModelSelection(modelName: string): Promise<void> {
		try {
			await invoke('api_save_transcript_config', {
				provider: 'parakeet',
				model: modelName,
				apiKey: null,
			});
		} catch (err) {
			console.error('Failed to save model selection:', err);
		}
	}

	async function downloadModel(modelName: string): Promise<void> {
		if (downloadingModels.has(modelName)) return;
		try {
			downloadingModels.add(modelName);
			setModelStatus(modelName, { Downloading: 0 });
			toast.info(`Downloading ${getModelDisplayName(modelName)}...`, {
				description: 'This may take a few minutes',
				duration: 5000,
			});
			await ParakeetAPI.downloadModel(modelName);
		} catch (err) {
			console.error('Download failed:', err);
			downloadingModels.delete(modelName);
			setModelStatus(modelName, { Error: err instanceof Error ? err.message : 'Download failed' });
		}
	}

	async function cancelDownload(modelName: string): Promise<void> {
		try {
			await ParakeetAPI.cancelDownload(modelName);
			downloadingModels.delete(modelName);
			setModelStatus(modelName, 'Missing');
			toast.info(`${getModelDisplayName(modelName)} download cancelled`, { duration: 3000 });
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
		toast.success(`Switched to ${getModelDisplayName(modelName)}`, { duration: 3000 });
	}

	async function deleteModel(modelName: string): Promise<void> {
		try {
			await ParakeetAPI.deleteCorruptedModel(modelName);
			models = await ParakeetAPI.getAvailableModels();
			toast.success(`${getModelDisplayName(modelName)} deleted`, {
				description: 'Model removed to free up space',
				duration: 3000,
			});
			if (selectedModel === modelName) onModelSelect?.('');
		} catch (err) {
			console.error('Failed to delete model:', err);
			toast.error(`Failed to delete ${getModelDisplayName(modelName)}`, {
				description: err instanceof Error ? err.message : 'Delete failed',
			});
		}
	}

	onMount(() => {
		(async () => {
			try {
				loading = true;
				await ParakeetAPI.init();
				models = await ParakeetAPI.getAvailableModels();
			} catch (err) {
				console.error('Failed to initialize Parakeet:', err);
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
					'parakeet-model-download-progress',
					(event) =>
						setModelStatus(event.payload.modelName, { Downloading: event.payload.progress }),
				),
			);
			push(
				await listen<{ modelName: string }>('parakeet-model-download-complete', (event) => {
					const { modelName } = event.payload;
					setModelStatus(modelName, 'Available');
					downloadingModels.delete(modelName);
					toast.success(`${getModelDisplayName(modelName)} ready!`, {
						description: 'Model downloaded and ready to use',
						duration: 4000,
					});
					onModelSelect?.(modelName);
					if (autoSave) void saveModelSelection(modelName);
				}),
			);
			push(
				await listen<{ modelName: string; error: string }>(
					'parakeet-model-download-error',
					(event) => {
						const { modelName, error: errMsg } = event.payload;
						setModelStatus(modelName, { Error: errMsg });
						downloadingModels.delete(modelName);
						toast.error(`Failed to download ${getModelDisplayName(modelName)}`, {
							description: errMsg,
							duration: 6000,
						});
					},
				),
			);
		})();

		return () => {
			cancelled = true;
			for (const fn of unsubscribers) fn();
		};
	});
</script>

{#if loading}
	<div class={cn('flex flex-col gap-3', className)}>
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
		{#if recommendedModel}
			<ParakeetModelCard
				model={recommendedModel}
				isSelected={selectedModel === recommendedModel.name}
				isRecommended={true}
				isDownloading={downloadingModels.has(recommendedModel.name)}
				onSelect={() =>
					recommendedModel.status === 'Available' && selectModel(recommendedModel.name)}
				onDownload={() => downloadModel(recommendedModel.name)}
				onCancel={() => cancelDownload(recommendedModel.name)}
				onDelete={() => deleteModel(recommendedModel.name)}
			/>
		{/if}

		{#each otherModels as model (model.name)}
			<ParakeetModelCard
				{model}
				isSelected={selectedModel === model.name}
				isRecommended={false}
				isDownloading={downloadingModels.has(model.name)}
				onSelect={() => model.status === 'Available' && selectModel(model.name)}
				onDownload={() => downloadModel(model.name)}
				onCancel={() => cancelDownload(model.name)}
				onDelete={() => deleteModel(model.name)}
			/>
		{/each}

		{#if selectedModel}
			<div in:fly={{ y: -5 }} class="pt-2 text-center text-xs text-muted-foreground">
				Using {getModelDisplayName(selectedModel)} for transcription
			</div>
		{/if}
	</div>
{/if}
