<script lang="ts" module>
	export interface ChunkStatus {
		chunk_id: number;
		status: 'pending' | 'processing' | 'completed' | 'failed';
		start_time?: number;
		end_time?: number;
		duration_ms?: number;
		text_preview?: string;
		error_message?: string;
	}

	export interface ProcessingProgress {
		total_chunks: number;
		completed_chunks: number;
		processing_chunks: number;
		failed_chunks: number;
		estimated_remaining_ms?: number;
		chunks: ChunkStatus[];
	}

	function formatDuration(ms: number): string {
		const seconds = Math.floor(ms / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);

		if (hours > 0) {
			return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
		} else if (minutes > 0) {
			return `${minutes}m ${seconds % 60}s`;
		}
		return `${seconds}s`;
	}

	function formatTimeRemaining(ms?: number): string {
		if (!ms || ms <= 0) return 'Calculating...';
		return formatDuration(ms);
	}

	function statusIcon(status: ChunkStatus['status']): string {
		switch (status) {
			case 'completed':
				return '✅';
			case 'processing':
				return '⚡';
			case 'failed':
				return '❌';
			default:
				return '⏳';
		}
	}

	function statusColor(status: ChunkStatus['status']): string {
		switch (status) {
			case 'completed':
				return 'text-success bg-success/10 border-success/20';
			case 'processing':
				return 'text-accent bg-accent/10 border-accent/20';
			case 'failed':
				return 'text-destructive bg-destructive/5 border-destructive/20';
			default:
				return 'text-muted-foreground bg-secondary border-border';
		}
	}
</script>

<script lang="ts">
	import { cn } from '$lib/utils';
	import * as Alert from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Progress } from '$lib/components/ui/progress';

	interface Props {
		progress: ProcessingProgress;
		onPause?: () => void;
		onResume?: () => void;
		onCancel?: () => void;
		isPaused?: boolean;
		class?: string;
	}

	let {
		progress,
		onPause,
		onResume,
		onCancel,
		isPaused = false,
		class: className = '',
	}: Props = $props();

	const completionPercentage = $derived(
		progress.total_chunks > 0
			? Math.round((progress.completed_chunks / progress.total_chunks) * 100)
			: 0,
	);

	const pendingChunks = $derived(
		progress.total_chunks -
			progress.completed_chunks -
			progress.processing_chunks -
			progress.failed_chunks,
	);

	const recentChunks = $derived([...progress.chunks].slice(-10).reverse());
</script>

<div class={cn('rounded-lg border border-border bg-card p-4', className)}>
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center gap-3">
			<h3 class="text-lg font-semibold text-foreground">Processing Progress</h3>
			{#if isPaused}
				<Badge variant="secondary">Paused</Badge>
			{/if}
		</div>

		<div class="flex items-center gap-2">
			{#if !isPaused}
				<Button
					variant="secondary"
					size="sm"
					onclick={onPause}
					disabled={progress.processing_chunks === 0 &&
						progress.completed_chunks === progress.total_chunks}
				>
					Pause
				</Button>
			{:else}
				<Button size="sm" onclick={onResume}>Resume</Button>
			{/if}

			<Button variant="destructive" size="sm" onclick={onCancel}>Cancel</Button>
		</div>
	</div>

	<div class="mb-4">
		<div class="mb-2 flex items-center justify-between">
			<span class="text-sm font-medium text-foreground">
				{progress.completed_chunks} of {progress.total_chunks} chunks completed
			</span>
			<span class="text-sm font-medium text-foreground">{completionPercentage}%</span>
		</div>

		<Progress value={completionPercentage} class="h-2" />
	</div>

	<div class="mb-4 grid grid-cols-4 gap-4 text-sm">
		<div class="text-center">
			<div class="text-lg font-semibold text-success">{progress.completed_chunks}</div>
			<div class="text-muted-foreground">Completed</div>
		</div>
		<div class="text-center">
			<div class="text-lg font-semibold text-accent">{progress.processing_chunks}</div>
			<div class="text-muted-foreground">Processing</div>
		</div>
		<div class="text-center">
			<div class="text-lg font-semibold text-muted-foreground">{pendingChunks}</div>
			<div class="text-muted-foreground">Pending</div>
		</div>
		<div class="text-center">
			<div class="text-lg font-semibold text-destructive">{progress.failed_chunks}</div>
			<div class="text-muted-foreground">Failed</div>
		</div>
	</div>

	{#if progress.estimated_remaining_ms && progress.estimated_remaining_ms > 0}
		<Alert.Root class="mb-4 border-accent/20 bg-accent/10 text-accent">
			<span>⏱️</span>
			<Alert.Description class="text-accent">
				Estimated time remaining: {formatTimeRemaining(progress.estimated_remaining_ms)}
			</Alert.Description>
		</Alert.Root>
	{/if}

	<div class="flex flex-col gap-2">
		<h4 class="mb-2 text-sm font-medium text-foreground">
			Recent Chunks ({Math.min(progress.chunks.length, 10)} of {progress.total_chunks})
		</h4>

		<div class="flex max-h-48 flex-col gap-1 overflow-y-auto">
			{#each recentChunks as chunk (chunk.chunk_id)}
				<div class={cn('rounded border p-2 text-xs', statusColor(chunk.status))}>
					<div class="flex items-center justify-between">
						<div class="flex items-center gap-2">
							<span>{statusIcon(chunk.status)}</span>
							<span class="font-medium">Chunk {chunk.chunk_id}</span>
							{#if chunk.duration_ms}
								<span class="text-muted-foreground">({formatDuration(chunk.duration_ms)})</span>
							{/if}
						</div>

						{#if chunk.status === 'processing'}
							<div
								class="size-3 animate-spin rounded-full border border-accent border-t-transparent"
							></div>
						{/if}
					</div>

					{#if chunk.text_preview}
						<div class="mt-1 truncate text-xs text-foreground">"{chunk.text_preview}"</div>
					{/if}

					{#if chunk.error_message}
						<div class="mt-1 text-xs text-destructive">Error: {chunk.error_message}</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	{#if progress.completed_chunks === progress.total_chunks && progress.total_chunks > 0}
		<Alert.Root class="mt-4 border-success/20 bg-success/10 text-success">
			<span>🎉</span>
			<Alert.Title class="text-success">
				Processing completed! All {progress.total_chunks} chunks have been transcribed.
			</Alert.Title>
		</Alert.Root>
	{/if}
</div>
