<script lang="ts">
	import type { Component } from 'svelte';
	import { mergeProps } from 'bits-ui';
	import { slide } from 'svelte/transition';
	import { Box, CircleCheck, Ellipsis, Gauge, HardDrive, Target, Trash2 } from '@lucide/svelte';
	import { cn } from '$lib/utils';
	import * as Card from '$lib/components/ui/card';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';
	import { Separator } from '$lib/components/ui/separator';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';

	// Shared, data-agnostic model card used by the transcription managers (Whisper,
	// transcription and summary model lists. Callers pass already-derived display
	// fields plus a normalized status; optional fields (accuracy/speed, download/
	// delete callbacks) simply hide when absent.
	type Status = 'available' | 'missing' | 'error' | 'corrupted';

	interface Props {
		title: string;
		icon?: Component;
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
		icon: Icon = Box,
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

	const isDownloading = $derived(downloadProgress !== null);
	const isAvailable = $derived(status === 'available' && !isDownloading);

	function handleCardKeydown(event: KeyboardEvent): void {
		if (event.target !== event.currentTarget || !isAvailable) return;
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onSelect();
		}
	}
</script>

<div>
	<Card.Root
		role="button"
		tabindex={0}
		onclick={() => isAvailable && onSelect()}
		onkeydown={handleCardKeydown}
		class={cn(
			'relative gap-0 overflow-visible p-4 transition-[border-color,background-color,box-shadow]',
			isSelected && isAvailable
				? 'border-brand bg-brand/8 shadow-[inset_0_0_0_1px_var(--brand)]'
				: isAvailable
					? 'cursor-pointer hover:border-muted-foreground/40'
					: 'cursor-default bg-secondary/50',
		)}
	>
		{#if isRecommended}
			<Badge class="bg-brand text-brand-foreground absolute -left-2 -top-2">Recommended</Badge>
		{/if}

		<div class="flex items-start justify-between gap-4">
			<div class="flex min-w-0 flex-1 items-start gap-3">
				<div
					class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-foreground"
				>
					<Icon class="size-4" />
				</div>
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-center gap-2">
						<h3 class="font-semibold text-foreground">{title}</h3>
						{#if perfBadge}
							<Badge class={perfBadge.class}>{perfBadge.label}</Badge>
						{/if}
					</div>
					{#if tagline}
						<p class="mt-1 text-pretty text-sm text-muted-foreground">{tagline}</p>
					{/if}
					{#if sizeLabel || accuracyLabel || speedLabel}
						<div
							class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground"
						>
							{#if sizeLabel}
								<span class="flex items-center gap-1.5 tabular-nums"
									><HardDrive class="size-3.5" /> {sizeLabel}</span
								>
							{/if}
							{#if accuracyLabel}
								<span class="flex items-center gap-1.5"
									><Target class="size-3.5" /> {accuracyLabel}</span
								>
							{/if}
							{#if speedLabel}
								<span class="flex items-center gap-1.5"
									><Gauge class="size-3.5" /> {speedLabel}</span
								>
							{/if}
						</div>
					{/if}
				</div>
			</div>

			<div class="flex items-center gap-2">
				{#if isDownloading}
					<!-- Progress + cancel render below the row. -->
				{:else if isAvailable}
					{#if isSelected}
						<Badge class="shrink-0 bg-brand text-brand-foreground">
							<CircleCheck /> Selected
						</Badge>
					{:else}
						<div class="flex shrink-0 items-center gap-1.5 text-success">
							<CircleCheck class="size-3.5" />
							<span class="text-xs font-medium">Ready</span>
						</div>
					{/if}
					{#if onDelete}
						<DropdownMenu.Root>
							<DropdownMenu.Trigger>
								{#snippet child({ props })}
									<Button
										{...mergeProps(props, {
											onclick: (event: MouseEvent) => event.stopPropagation(),
										})}
										variant="ghost"
										size="icon"
										aria-label={`${title} actions`}
										class="-mr-2 size-10 text-muted-foreground transition-[color,background-color,scale] duration-150 ease-out active:scale-[0.96]"
									>
										<Ellipsis />
									</Button>
								{/snippet}
							</DropdownMenu.Trigger>
							<DropdownMenu.Content align="end" class="min-w-48">
								<DropdownMenu.Item
									variant="destructive"
									class="min-h-10"
									onSelect={() => onDelete?.()}
								>
									<Trash2 />
									Remove download
								</DropdownMenu.Item>
							</DropdownMenu.Content>
						</DropdownMenu.Root>
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
