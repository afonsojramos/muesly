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
				return 'text-green-600 bg-green-50 border-green-200';
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
		class: className = ''
	}: Props = $props();

	const completionPercentage = $derived(
		progress.total_chunks > 0
			? Math.round((progress.completed_chunks / progress.total_chunks) * 100)
			: 0
	);

	const pendingChunks = $derived(
		progress.total_chunks -
			progress.completed_chunks -
			progress.processing_chunks -
			progress.failed_chunks
	);

	const recentChunks = $derived([...progress.chunks].slice(-10).reverse());
</script>

<div class={cn('rounded-lg border border-border bg-card p-4', className)}>
	<div class="mb-4 flex items-center justify-between">
		<div class="flex items-center space-x-3">
			<h3 class="text-lg font-semibold text-foreground">Processing Progress</h3>
			{#if isPaused}
				<span class="rounded-full bg-yellow-100 px-2 py-1 text-xs font-medium text-yellow-800">
					Paused
				</span>
			{/if}
		</div>

		<div class="flex items-center space-x-2">
			{#if !isPaused}
				<button
					onclick={onPause}
					class="rounded bg-yellow-500 px-3 py-1 text-sm text-white transition-colors hover:bg-yellow-600 disabled:opacity-50"
					disabled={progress.processing_chunks === 0 &&
						progress.completed_chunks === progress.total_chunks}
				>
					Pause
				</button>
			{:else}
				<button
					onclick={onResume}
					class="rounded bg-green-500 px-3 py-1 text-sm text-white transition-colors hover:bg-green-600"
				>
					Resume
				</button>
			{/if}

			<button
				onclick={onCancel}
				class="rounded bg-destructive px-3 py-1 text-sm text-destructive-foreground transition-colors hover:bg-destructive/90"
			>
				Cancel
			</button>
		</div>
	</div>

	<div class="mb-4">
		<div class="mb-2 flex items-center justify-between">
			<span class="text-sm font-medium text-foreground">
				{progress.completed_chunks} of {progress.total_chunks} chunks completed
			</span>
			<span class="text-sm font-medium text-foreground">{completionPercentage}%</span>
		</div>

		<div class="h-2 w-full rounded-full bg-secondary">
			<div
				class="h-2 rounded-full bg-accent transition-all duration-300 ease-out"
				style={`width: ${completionPercentage}%`}
			></div>
		</div>
	</div>

	<div class="mb-4 grid grid-cols-4 gap-4 text-sm">
		<div class="text-center">
			<div class="text-lg font-semibold text-green-600">{progress.completed_chunks}</div>
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
		<div class="mb-4 rounded-lg border border-accent/20 bg-accent/10 p-3">
			<div class="flex items-center space-x-2">
				<span class="text-accent">⏱️</span>
				<span class="text-sm text-accent">
					Estimated time remaining: {formatTimeRemaining(progress.estimated_remaining_ms)}
				</span>
			</div>
		</div>
	{/if}

	<div class="space-y-2">
		<h4 class="mb-2 text-sm font-medium text-foreground">
			Recent Chunks ({Math.min(progress.chunks.length, 10)} of {progress.total_chunks})
		</h4>

		<div class="max-h-48 space-y-1 overflow-y-auto">
			{#each recentChunks as chunk (chunk.chunk_id)}
				<div class={cn('rounded border p-2 text-xs', statusColor(chunk.status))}>
					<div class="flex items-center justify-between">
						<div class="flex items-center space-x-2">
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
		<div class="mt-4 rounded-lg border border-green-200 bg-green-50 p-3">
			<div class="flex items-center space-x-2">
				<span class="text-green-600">🎉</span>
				<span class="text-sm font-medium text-green-800">
					Processing completed! All {progress.total_chunks} chunks have been transcribed.
				</span>
			</div>
		</div>
	{/if}
</div>
