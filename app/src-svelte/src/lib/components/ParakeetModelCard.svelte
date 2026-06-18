<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { Trash2 } from '@lucide/svelte';
	import {
		formatFileSize,
		getModelDisplayInfo,
		getModelPerformanceBadge,
		type ParakeetModelInfo
	} from '$lib/ai/parakeet';
	import { cn } from '$lib/utils';
	import Tooltip from '$lib/ui/tooltip.svelte';

	interface Props {
		model: ParakeetModelInfo;
		isSelected: boolean;
		isRecommended: boolean;
		isDownloading: boolean;
		onSelect: () => void;
		onDownload: () => void;
		onCancel: () => void;
		onDelete: () => void;
	}

	let { model, isSelected, isRecommended, onSelect, onDownload, onCancel, onDelete }: Props =
		$props();

	let isHovered = $state(false);

	const displayInfo = $derived(getModelDisplayInfo(model.name));
	const displayName = $derived(displayInfo?.friendlyName ?? model.name);
	const icon = $derived(displayInfo?.icon ?? '📦');
	const tagline = $derived(displayInfo?.tagline ?? model.description ?? '');

	const isAvailable = $derived(model.status === 'Available');
	const isMissing = $derived(model.status === 'Missing');
	const isError = $derived(typeof model.status === 'object' && 'Error' in model.status);
	const isCorrupted = $derived(typeof model.status === 'object' && 'Corrupted' in model.status);
	const downloadProgress = $derived(
		typeof model.status === 'object' && 'Downloading' in model.status
			? model.status.Downloading
			: null
	);
	const badge = $derived(getModelPerformanceBadge(model.quantization));
	const badgeClass = $derived(
		badge.color === 'green' ? 'bg-green-100 text-green-700' : 'bg-accent/15 text-accent'
	);
</script>

<div
	in:fly={{ y: 5, duration: 200 }}
	role="button"
	tabindex="0"
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	onclick={() => isAvailable && onSelect()}
	onkeydown={(e) => e.key === 'Enter' && isAvailable && onSelect()}
	class={cn(
		'relative rounded-lg border-2 transition-all',
		isSelected && isAvailable
			? 'border-accent bg-accent/5'
			: isAvailable
				? 'cursor-pointer border-border bg-background hover:border-muted-foreground/40'
				: 'cursor-default border-border bg-secondary/50'
	)}
>
	{#if isRecommended}
		<div
			class="absolute -right-2 -top-2 rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground"
		>
			Recommended
		</div>
	{/if}

	<div class="p-4">
		<div class="mb-3 flex items-start justify-between">
			<div class="flex-1">
				<div class="mb-1 flex items-center gap-2">
					<span class="text-2xl">{icon}</span>
					<h3 class="font-semibold">{displayName}</h3>
					{#if isSelected && isAvailable}
						<span class="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-accent-foreground">✓</span>
					{/if}
					<span class={`rounded-full px-2 py-0.5 text-xs ${badgeClass}`}>{badge.label}</span>
				</div>
				<p class="ml-9 text-sm text-muted-foreground">{tagline}</p>
				<div class="ml-9 mt-1.5 flex items-center space-x-4 text-sm text-muted-foreground">
					<span>📦 {formatFileSize(model.size_mb)}</span>
					<span>🎯 {model.accuracy} accuracy</span>
					<span>⚡ {model.speed}</span>
				</div>
			</div>

			<div class="ml-4 flex items-center gap-2">
				{#if isAvailable}
					<div class="flex items-center gap-1.5 text-green-600">
						<div class="size-2 rounded-full bg-green-500"></div>
						<span class="text-xs font-medium">Ready</span>
					</div>
					{#if isHovered}
						<Tooltip label="Delete model">
							{#snippet trigger()}
								<button
									in:fly={{ duration: 150 }}
									onclick={(e) => {
										e.stopPropagation();
										onDelete();
									}}
									class="p-1 text-muted-foreground transition-colors hover:text-destructive"
									aria-label="Delete model"
								>
									<Trash2 class="size-4" />
								</button>
							{/snippet}
						</Tooltip>
					{/if}
				{:else if isMissing}
					<button
						onclick={(e) => {
							e.stopPropagation();
							onDownload();
						}}
						class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground transition-colors hover:opacity-90"
					>
						Download
					</button>
				{:else if downloadProgress === null && isError}
					<button
						onclick={(e) => {
							e.stopPropagation();
							onDownload();
						}}
						class="rounded-md bg-destructive px-3 py-1.5 text-sm font-medium text-destructive-foreground transition-colors hover:opacity-90"
					>
						Retry
					</button>
				{:else if isCorrupted}
					<div class="flex gap-2">
						<button
							onclick={(e) => {
								e.stopPropagation();
								onDelete();
							}}
							class="rounded-md bg-orange-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-orange-700"
						>
							Delete
						</button>
						<button
							onclick={(e) => {
								e.stopPropagation();
								onDownload();
							}}
							class="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:opacity-90"
						>
							Re-download
						</button>
					</div>
				{/if}
			</div>
		</div>

		{#if downloadProgress !== null}
			<div transition:slide class="mt-3 border-t border-border pt-3">
				<div class="mb-2 flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-accent">Downloading...</span>
						<span class="text-sm font-semibold text-accent">{Math.round(downloadProgress)}%</span>
					</div>
					<button
						onclick={(e) => {
							e.stopPropagation();
							onCancel();
						}}
						class="rounded px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
					>
						Cancel
					</button>
				</div>
				<div class="h-2 w-full overflow-hidden rounded-full bg-secondary">
					<div
						class="h-full rounded-full bg-accent transition-all duration-300 ease-out"
						style={`width: ${downloadProgress}%`}
					></div>
				</div>
				<p class="mt-1 text-xs text-muted-foreground">
					{formatFileSize((model.size_mb * downloadProgress) / 100)} / {formatFileSize(model.size_mb)}
				</p>
			</div>
		{/if}
	</div>
</div>
