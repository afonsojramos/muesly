<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { listen, type UnlistenFn } from '@tauri-apps/api/event';
	import { BadgeAlert, Download, RefreshCw, Trash2 } from '@lucide/svelte';
	import { onMount } from 'svelte';
	import { SvelteMap, SvelteSet } from 'svelte/reactivity';

	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { toast } from '$lib/toast';
	import { cn } from '$lib/utils';

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
		Loading models...
	</div>
{:else if hasFetched && models.length === 0}
	<Alert.Root>
		<Alert.Description>
			No models found. Download a model to get started with Built-in AI.
		</Alert.Description>
	</Alert.Root>
{:else}
	<div>
		<div class="mb-4 flex items-center justify-between">
			<h4 class="text-sm font-bold">Built-in AI Models</h4>
		</div>

		<div class="grid gap-4">
			{#each models as model (model.name)}
				{@const progress = downloadProgress.get(model.name)}
				{@const progressInfo = downloadProgressInfo.get(model.name)}
				{@const modelIsDownloading = downloadingModels.has(model.name)}
				{@const isAvailable = model.status.type === 'available'}
				{@const isNotDownloaded = model.status.type === 'not_downloaded'}
				{@const isCorrupted = model.status.type === 'corrupted'}
				{@const isError = model.status.type === 'error'}
				<div
					role="button"
					tabindex="0"
					onclick={() => isAvailable && !modelIsDownloading && onModelSelect(model.name)}
					onkeydown={(e) =>
						e.key === 'Enter' && isAvailable && !modelIsDownloading && onModelSelect(model.name)}
					class={cn(
						'rounded-lg border p-4 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
						selectedModel === model.name
							? 'border-accent ring-1 ring-inset ring-accent'
							: 'border-border hover:border-muted-foreground/40',
						isAvailable && !modelIsDownloading ? 'cursor-pointer bg-card' : 'bg-card',
					)}
				>
					<div class="flex items-start justify-between">
						<div class="flex-1">
							<div class="mb-1 flex items-center gap-2">
								<span class="text-base font-bold">{model.display_name || model.name}</span>
								{#if isAvailable}
									<span class="flex items-center gap-1 text-xs font-medium text-success">
										<span class="size-2 rounded-full bg-success"></span> Ready
									</span>
									{#if selectedModel === model.name}
										<Badge class="bg-accent/15 text-accent">Selected</Badge>
									{/if}
								{:else if isCorrupted}
									<Badge variant="destructive">
										<BadgeAlert /> Corrupted
									</Badge>
								{:else if isError}
									<Badge variant="destructive">Error</Badge>
								{:else if isNotDownloaded && !modelIsDownloading}
									<span class="text-xs font-medium text-muted-foreground">Not Downloaded</span>
								{/if}
							</div>
							<div class="text-sm text-muted-foreground">
								{#if model.description}<p class="mb-1">{model.description}</p>{/if}
								<div class="text-xs text-muted-foreground/80">
									{model.size_mb}MB • {formatContext(model.context_size)} context
								</div>
							</div>
						</div>

						<div class="ml-4 flex items-center gap-2">
							{#if isNotDownloaded && !modelIsDownloading}
								<Button
									variant="outline"
									size="sm"
									onclick={(e) => {
										e.stopPropagation();
										downloadModel(model.name);
									}}
								>
									<Download data-icon="inline-start" /> Download
								</Button>
							{:else if modelIsDownloading}
								<Button
									variant="outline"
									size="sm"
									onclick={(e) => {
										e.stopPropagation();
										cancelDownload(model.name);
									}}
								>
									Cancel
								</Button>
							{:else if isError}
								<Button
									variant="outline"
									size="sm"
									onclick={(e) => {
										e.stopPropagation();
										downloadModel(model.name);
									}}
								>
									<RefreshCw data-icon="inline-start" /> Retry
								</Button>
							{:else if isCorrupted}
								<Button
									variant="outline"
									size="sm"
									onclick={(e) => {
										e.stopPropagation();
										downloadModel(model.name);
									}}
								>
									<RefreshCw data-icon="inline-start" /> Retry
								</Button>
								<Button
									variant="outline"
									size="sm"
									onclick={(e) => {
										e.stopPropagation();
										deleteModel(model.name);
									}}
								>
									<Trash2 data-icon="inline-start" /> Delete
								</Button>
							{:else if isAvailable && selectedModel !== model.name}
								<Tooltip.Provider delayDuration={300}>
									<Tooltip.Root>
										<Tooltip.Trigger>
											{#snippet child({ props })}
												<Button
													{...props}
													variant="ghost"
													size="icon-sm"
													class="text-muted-foreground hover:text-destructive"
													onclick={(e) => {
														e.stopPropagation();
														deleteModel(model.name);
													}}
													aria-label="Delete model"
												>
													<Trash2 />
												</Button>
											{/snippet}
										</Tooltip.Trigger>
										<Tooltip.Content>Delete model</Tooltip.Content>
									</Tooltip.Root>
								</Tooltip.Provider>
							{/if}
						</div>
					</div>

					{#if modelIsDownloading && progress !== undefined}
						<div class="mt-3">
							<Separator class="mb-3" />
							<div class="mb-1 flex items-center justify-between">
								<span class="text-sm font-medium">Downloading...</span>
								<span class="text-sm font-semibold">{Math.round(progress)}%</span>
							</div>
							<div class="mb-2 text-sm text-muted-foreground">
								{#if progressInfo && progressInfo.totalMb > 0}
									{progressInfo.downloadedMb.toFixed(1)} MB / {progressInfo.totalMb.toFixed(1)} MB
									{#if progressInfo.speedMbps > 0}
										<span class="ml-2 text-muted-foreground/70"
											>({progressInfo.speedMbps.toFixed(1)} MB/s)</span
										>
									{/if}
								{:else}
									{model.size_mb} MB
								{/if}
							</div>
							<Progress value={progress} class="h-2.5" />
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
{/if}
