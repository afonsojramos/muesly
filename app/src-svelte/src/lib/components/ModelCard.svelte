<script lang="ts">
	import { fly, slide } from 'svelte/transition';
	import { Trash2 } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';

	// Shared, data-agnostic model card used by the transcription managers (Whisper,
	// transcription and summary model lists. Callers pass already-derived display
	// fields plus a normalized status; optional fields (accuracy/speed, download/
	// delete callbacks) simply hide when absent.
	type Status = 'available' | 'missing' | 'error' | 'corrupted';

	interface Props {
		title: string;
		icon?: string;
		tagline?: string;
		sizeLabel?: string;
		accuracyLabel?: string;
		speedLabel?: string;
		perfBadge?: { label: string; class: string };
		isSelected: boolean;
		isRecommended?: boolean;
		status?: Status;
		/** 0–100 while downloading, otherwise null. */
		downloadProgress?: number | null;
		/** e.g. "1.2 GB / 3 GB", shown under the progress bar. */
		progressLabel?: string;
		onSelect: () => void;
		onDownload?: () => void;
		onCancel?: () => void;
		onDelete?: () => void;
	}

	let {
		title,
		icon = '📦',
		tagline,
		sizeLabel,
		accuracyLabel,
		speedLabel,
		perfBadge,
		isSelected,
		isRecommended = false,
		status = 'available',
		downloadProgress = null,
		progressLabel,
		onSelect,
		onDownload,
		onCancel,
		onDelete,
	}: Props = $props();

	let isHovered = $state(false);

	const isDownloading = $derived(downloadProgress !== null);
	const isAvailable = $derived(status === 'available' && !isDownloading);
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
			'relative gap-0 overflow-visible border-2 p-3 transition-all',
			isSelected && isAvailable
				? 'border-brand bg-brand/5'
				: isAvailable
					? 'cursor-pointer hover:border-muted-foreground/40'
					: 'cursor-default bg-secondary/50',
		)}
	>
		{#if isRecommended}
			<Badge class="bg-brand text-brand-foreground absolute -left-2 -top-2">Recommended</Badge>
		{/if}

		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0 flex-1">
				<div class="mb-2 flex flex-wrap items-center gap-2">
					<span class="text-2xl">{icon}</span>
					<h3 class="font-semibold">{title}</h3>
					{#if tagline}
						<span class="text-sm text-muted-foreground">•</span>
						<span class="text-sm text-muted-foreground">{tagline}</span>
					{/if}
					{#if perfBadge}
						<Badge class={perfBadge.class}>{perfBadge.label}</Badge>
					{/if}
				</div>
				{#if sizeLabel || accuracyLabel || speedLabel}
					<div class="ml-9 mt-1.5 flex items-center gap-4 text-sm text-muted-foreground">
						{#if sizeLabel}<span>📦 {sizeLabel}</span>{/if}
						{#if accuracyLabel}<span>🎯 {accuracyLabel}</span>{/if}
						{#if speedLabel}<span>⚡ {speedLabel}</span>{/if}
					</div>
				{/if}
			</div>

			<div class="flex items-center gap-2">
				{#if isDownloading}
					<!-- Progress + cancel render below the row. -->
				{:else if isAvailable}
					{#if onDelete}
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
														onDelete?.();
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
					{/if}
				{:else if status === 'missing' && onDownload}
					<Button
						variant="brand"
						size="sm"
						onclick={(e) => {
							e.stopPropagation();
							onDownload?.();
						}}
					>
						Download
					</Button>
				{:else if status === 'error' && onDownload}
					<Button
						variant="destructive"
						size="sm"
						onclick={(e) => {
							e.stopPropagation();
							onDownload?.();
						}}
					>
						Retry
					</Button>
				{:else if status === 'corrupted'}
					<div class="flex gap-2">
						{#if onDelete}
							<Button
								variant="outline"
								size="sm"
								class="text-warning hover:text-warning"
								onclick={(e) => {
									e.stopPropagation();
									onDelete?.();
								}}
							>
								Delete
							</Button>
						{/if}
						{#if onDownload}
							<Button
								variant="brand"
								size="sm"
								onclick={(e) => {
									e.stopPropagation();
									onDownload?.();
								}}
							>
								Re-download
							</Button>
						{/if}
					</div>
				{/if}
			</div>
		</div>

		{#if isDownloading}
			<div transition:slide class="mt-3">
				<Separator class="mb-3" />
				<div class="mb-2 flex items-center justify-between">
					<div class="flex items-center gap-2">
						<span class="text-sm font-medium text-brand">Downloading...</span>
						<span class="text-sm font-semibold text-brand">
							{Math.round(downloadProgress ?? 0)}%
						</span>
					</div>
					{#if onCancel}
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
												onCancel?.();
											}}
										>
											Cancel
										</Button>
									{/snippet}
								</Tooltip.Trigger>
								<Tooltip.Content>Cancel download</Tooltip.Content>
							</Tooltip.Root>
						</Tooltip.Provider>
					{/if}
				</div>
				<Progress value={downloadProgress ?? 0} class="h-2" />
				{#if progressLabel}
					<p class="mt-1 text-xs text-muted-foreground">{progressLabel}</p>
				{/if}
			</div>
		{/if}
	</Card.Root>
</div>
