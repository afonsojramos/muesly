<script lang="ts">
	import type { ModelStatus } from '$lib/ai/whisper';
	import { Progress } from '$lib/components/ui/progress';

	interface Props {
		status: ModelStatus;
		modelName: string;
		onCancel?: () => void;
	}

	let { status, modelName }: Props = $props();

	const progress = $derived(
		typeof status === 'object' && 'Downloading' in status ? status.Downloading : null,
	);
	const isCompleted = $derived(progress !== null && progress >= 100);
</script>

{#if progress !== null}
	<div class="rounded-lg border border-accent/20 bg-accent/5 p-4">
		<div class="mb-2 flex items-center justify-between">
			<div class="flex items-center gap-2">
				<div class="size-4 animate-spin rounded-full border-b-2 border-accent"></div>
				<span class="text-sm font-medium">
					{isCompleted ? 'Finalizing...' : `Downloading ${modelName}`}
				</span>
			</div>
		</div>

		<div class="relative">
			<Progress value={Math.min(progress, 100)} class="h-2" />
			<div class="mt-1 flex justify-between text-xs text-muted-foreground">
				<span>{Math.round(progress)}% complete</span>
				{#if !isCompleted}<span class="animate-pulse">Downloading...</span>{/if}
			</div>
		</div>

		{#if isCompleted}
			<div class="mt-2 text-xs text-success">✓ Download completed, loading model...</div>
		{/if}
	</div>
{/if}
