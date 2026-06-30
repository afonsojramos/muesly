<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { Trash2 } from '@lucide/svelte';
	import {
		formatFileSize,
		getModelIcon,
		getModelPerformanceBadge,
		getModelTagline,
		isQuantizedModel,
		type ModelInfo
	} from '$lib/ai/whisper';
	import { cn } from '$lib/utils';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';

	interface Props {
		model: ModelInfo;
		isSelected: boolean;
		isRecommended: boolean;
		isDownloading: boolean;
		displayName: string;
		onSelect: () => void;
		onDownload: () => void;
		onCancel: () => void;
		onDelete: () => void;
	}

	let { model, isSelected, isRecommended, displayName, onSelect, onDownload, onCancel, onDelete }: Props =
		$props();

	let isHovered = $state(false);

	const isAvailable = $derived(model.status === 'Available');
	const isMissing = $derived(model.status === 'Missing');
	const isError = $derived(typeof model.status === 'object' && 'Error' in model.status);
	const isCorrupted = $derived(typeof model.status === 'object' && 'Corrupted' in model.status);
	const downloadProgress = $derived(
		typeof model.status === 'object' && 'Downloading' in model.status
			? model.status.Downloading
			: null
	);
	const badge = $derived(getModelPerformanceBadge(model.name));
	const badgeClass = $derived(
		badge.color === 'green'
			? 'bg-success/10 text-success'
			: badge.color === 'orange'
				? 'bg-warning/10 text-warning'
				: 'bg-secondary text-muted-foreground'
	);
</script>

<div in:fly={{ y: 5, duration: 200 }}>
<Card.Root
	role="button"
	tabindex={0}
	onmouseenter={() => (isHovered = true)}
	onmouseleave={() => (isHovered = false)}
	onclick={() => isAvailable && onSelect()}
	onkeydown={(e) => e.key === 'Enter' && isAvailable && onSelect()}
	class={cn(
		'relative gap-0 border-2 p-3 transition-all',
		isSelected && isAvailable
			? 'border-accent bg-accent/5'
			: isAvailable
				? 'cursor-pointer hover:border-muted-foreground/40'
				: 'cursor-default bg-secondary/50'
	)}
>
	{#if isRecommended}
		<Badge class="bg-accent text-accent-foreground absolute -right-2 -top-2">Recommended</Badge>
	{/if}

	<div class="flex items-start justify-between gap-4">
		<div class="flex-1">
			<div class="mb-2 flex flex-wrap items-center gap-2">
				<span class="text-2xl">{getModelIcon(model.accuracy)}</span>
				<h3 class="font-semibold">{displayName}</h3>
				<span class="text-sm text-muted-foreground">•</span>
				<span class="text-sm text-muted-foreground">
					{getModelTagline(model.name, model.speed, model.accuracy)}
				</span>
				{#if isSelected && isAvailable}
					<Badge class="bg-accent text-accent-foreground">✓</Badge>
				{/if}
				{#if isQuantizedModel(model.name)}
					<Badge class={badgeClass}>{badge.label}</Badge>
				{/if}
			</div>
			<div class="ml-9 mt-1.5 flex items-center gap-4 text-sm text-muted-foreground">
				<span>📦 {formatFileSize(model.size_mb)}</span>
				<span>🎯 {model.accuracy} accuracy</span>
				<span>⚡ {model.speed} processing</span>
			</div>
		</div>

		<div class="flex items-center gap-2">
			{#if isAvailable}
				<div class="flex items-center gap-1.5 text-success">
					<div class="size-2 rounded-full bg-success"></div>
					<span class="text-xs font-medium">Ready</span>
				</div>
				{#if isHovered}
					<div in:fly={{ duration: 150 }}>
						<Tooltip.Provider delayDuration={300}>
							<Tooltip.Root>
								<Tooltip.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											aria-label="Delete model"
											onclick={(e) => {
												e.stopPropagation();
												onDelete();
											}}
											class="text-muted-foreground hover:text-destructive"
										>
											<Trash2 />
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content>Delete model to free up space</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
					</div>
				{/if}
			{:else if isMissing}
				<Button
					variant="accent"
					size="sm"
					onclick={(e) => {
						e.stopPropagation();
						onDownload();
					}}
				>
					Download
				</Button>
			{:else if downloadProgress === null && isError}
				<Button
					variant="destructive"
					size="sm"
					onclick={(e) => {
						e.stopPropagation();
						onDownload();
					}}
				>
					Retry
				</Button>
			{:else if isCorrupted}
				<div class="flex gap-2">
					<Button
						variant="outline"
						size="sm"
						class="text-warning hover:text-warning"
						onclick={(e) => {
							e.stopPropagation();
							onDelete();
						}}
					>
						Delete
					</Button>
					<Button
						variant="accent"
						size="sm"
						onclick={(e) => {
							e.stopPropagation();
							onDownload();
						}}
					>
						Re-download
					</Button>
				</div>
			{/if}
		</div>
	</div>

	{#if downloadProgress !== null}
		<div transition:slide class="mt-3">
			<Separator class="mb-3" />
			<div class="mb-2 flex items-center justify-between">
				<div class="flex items-center gap-2">
					<span class="text-sm font-medium text-accent">Downloading...</span>
					<span class="text-sm font-semibold text-accent">{Math.round(downloadProgress)}%</span>
				</div>
				<Tooltip.Provider delayDuration={300}>
					<Tooltip.Root>
						<Tooltip.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="xs"
									class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
									onclick={(e) => {
										e.stopPropagation();
										onCancel();
									}}
								>
									Cancel
								</Button>
							{/snippet}
						</Tooltip.Trigger>
						<Tooltip.Content>Cancel download</Tooltip.Content>
					</Tooltip.Root>
				</Tooltip.Provider>
			</div>
			<Progress value={downloadProgress} class="h-2" />
			<p class="mt-1 text-xs text-muted-foreground">
				{#if model.size_mb}
					{formatFileSize((model.size_mb * downloadProgress) / 100)} / {formatFileSize(model.size_mb)}
				{:else}
					Downloading...
				{/if}
			</p>
		</div>
	{/if}
</Card.Root>
</div>
