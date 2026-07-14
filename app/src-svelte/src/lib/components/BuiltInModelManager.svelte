<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { BrainCircuit, RefreshCw } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	import * as Alert from '$lib/components/ui/alert';
	import { toast } from '$lib/toast';
	import ModelCard from './ModelCard.svelte';

	interface ModelInfo {
		name: string;
		display_name: string;
		status: {
			type: 'not_downloaded' | 'downloading' | 'available' | 'corrupted' | 'error';
			progress?: number;
		};
		size_mb: number;
		context_size: number;
		description: string;
		gguf_file: string;
	}

	interface DownloadProgressInfo {
		downloadedMb: number;
		totalMb: number;
		speedMbps: number;
	}

	interface Props {
		selectedModel: string;
		onModelSelect: (model: string) => void;
	}

	let { selectedModel, onModelSelect }: Props = $props();

	let models = $state<ModelInfo[]>([]);
	let isLoading = $state(false);
	let hasFetched = $state(false);
	const downloadProgress = new SvelteMap<string, number>();
	const downloadProgressInfo = new SvelteMap<string, DownloadProgressInfo>();
	const downloadingModels = new SvelteSet<string>();

	// Context window as "K" (the LLM convention: K = 1024, so 32768 → "32K").
	// Falls back to a decimal for the rare non-power-of-two size.
	function formatContext(tokens: number): string {
		if (tokens < 1024) return `${tokens}`;
		const k = tokens / 1024;
		return `${Number.isInteger(k) ? k : k.toFixed(1)}K`;
	}

	function modelStatus(model: ModelInfo): 'available' | 'missing' | 'error' | 'corrupted' {
		switch (model.status.type) {
			case 'available':
				return 'available';
			case 'corrupted':
				return 'corrupted';
			case 'error':
				return 'error';
			default:
				return 'missing';
		}
	}

	function progressLabel(model: ModelInfo, info?: DownloadProgressInfo): string {
		if (!info || info.totalMb <= 0) return `${model.size_mb} MB`;
		const transferred = `${info.downloadedMb.toFixed(1)} MB / ${info.totalMb.toFixed(1)} MB`;
		return info.speedMbps > 0 ? `${transferred} · ${info.speedMbps.toFixed(1)} MB/s` : transferred;
	}

	async function fetchModels(): Promise<void> {
		try {
			isLoading = true;
			const data = (await invoke('builtin_ai_list_models')) as ModelInfo[];
			models = data;
			if (data.length > 0 && !selectedModel) {
				const firstAvailable = data.find((m) => m.status.type === 'available');
				if (firstAvailable) onModelSelect(firstAvailable.name);
			}
		} catch (error) {
			console.error('Failed to fetch built-in AI models:', error);
			toast.error('Failed to load models');
		} finally {
			isLoading = false;
			hasFetched = true;
		}
	}

	function clearProgress(model: string): void {
		downloadingModels.delete(model);
		downloadProgress.delete(model);
		downloadProgressInfo.delete(model);
	}

	async function downloadModel(modelName: string): Promise<void> {
		try {
			downloadingModels.add(modelName);
			await invoke('builtin_ai_download_model', { modelName });
		} catch (error) {
			const errorMsg = String(error);
			if (errorMsg.startsWith('CANCELLED:')) return;
			console.error('Failed to download model:', error);
			toast.error(`Failed to download ${modelName}`);
			downloadingModels.delete(modelName);
			void fetchModels();
		}
	}

	async function cancelDownload(modelName: string): Promise<void> {
		try {
			await invoke('builtin_ai_cancel_download', { modelName });
			toast.info(`Download of ${modelName} cancelled`);
			downloadingModels.delete(modelName);
		} catch (error) {
			console.error('Failed to cancel download:', error);
		}
	}

	async function deleteModel(modelName: string): Promise<void> {
		try {
			await invoke('builtin_ai_delete_model', { modelName });
			toast.success(`Model ${modelName} deleted`);
			void fetchModels();
		} catch (error) {
			console.error('Failed to delete model:', error);
			toast.error(`Failed to delete ${modelName}`);
		}
	}

	onMount(() => {
		void fetchModels();

		let unlisten: UnlistenFn | undefined;
		let cancelled = false;

		listen<{
			model: string;
			progress: number;
			downloaded_mb?: number;
			total_mb?: number;
			speed_mbps?: number;
			status: string;
		}>('builtin-ai-download-progress', (event) => {
			const { model, progress, downloaded_mb, total_mb, speed_mbps, status } = event.payload;
			downloadProgress.set(model, progress);
			downloadProgressInfo.set(model, {
				downloadedMb: downloaded_mb ?? 0,
				totalMb: total_mb ?? 0,
				speedMbps: speed_mbps ?? 0,
			});

			if (status === 'downloading') {
				downloadingModels.add(model);
			} else if (status === 'completed') {
				clearProgress(model);
				void fetchModels();
				toast.success(`Model ${model} downloaded successfully`);
			} else if (status === 'cancelled') {
				clearProgress(model);
				void fetchModels();
			} else if (status === 'error') {
				clearProgress(model);
				models = models.map((m) =>
					m.name === model ? { ...m, status: { type: 'error', progress: 0 } } : m,
				);
			}
		}).then((fn) => {
			if (cancelled) fn();
			else unlisten = fn;
		});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	});
</script>

{#if isLoading && downloadingModels.size === 0}
	<div class="py-8 text-center text-muted-foreground">
		<RefreshCw class="mx-auto mb-2 size-8 animate-spin" />
		Loading models…
	</div>
{:else if hasFetched && models.length === 0}
	<Alert.Root>
		<Alert.Description>
			No models found. Download a model to get started with Built-in AI.
		</Alert.Description>
	</Alert.Root>
{:else}
	<div class="flex flex-col gap-3">
		<div>
			<h4 class="font-medium">Built-in models</h4>
			<p class="text-pretty text-sm text-muted-foreground">
				Private, on-device models for summaries and chat. Larger context can handle longer meetings.
			</p>
		</div>

		<div class="grid gap-3">
			{#each models as model (model.name)}
				{@const progress = downloadProgress.get(model.name)}
				{@const progressInfo = downloadProgressInfo.get(model.name)}
				{@const modelIsDownloading = downloadingModels.has(model.name)}
				<ModelCard
					title={model.display_name || model.name}
					icon={BrainCircuit}
					tagline={model.description}
					sizeLabel={`${model.size_mb} MB`}
					perfBadge={{
						label: `${formatContext(model.context_size)} context`,
						class: 'bg-secondary text-muted-foreground',
					}}
					isSelected={selectedModel === model.name}
					status={modelStatus(model)}
					downloadProgress={modelIsDownloading ? (progress ?? 0) : null}
					progressLabel={modelIsDownloading ? progressLabel(model, progressInfo) : undefined}
					onSelect={() => onModelSelect(model.name)}
					onDownload={() => downloadModel(model.name)}
					onCancel={() => cancelDownload(model.name)}
					onDelete={selectedModel === model.name ? undefined : () => deleteModel(model.name)}
				/>
			{/each}
		</div>
	</div>
{/if}
