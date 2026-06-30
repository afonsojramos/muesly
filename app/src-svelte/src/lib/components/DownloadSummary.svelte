<script lang="ts">
	interface Props {
		totalModels: number;
		downloadedModels: number;
		totalSizeMb: number;
	}

	let { totalModels, downloadedModels, totalSizeMb }: Props = $props();

	const formatSize = (mb: number): string => (mb >= 1000 ? `${(mb / 1000).toFixed(1)}GB` : `${mb}MB`);
</script>

<div class="rounded-lg bg-secondary p-3 text-sm">
	<div class="flex items-center justify-between">
		<span class="text-foreground">📦 {downloadedModels} of {totalModels} models available</span>
		<span class="text-muted-foreground">💾 {formatSize(totalSizeMb)} total</span>
	</div>
	{#if downloadedModels > 0}
		<div class="mt-1 text-xs text-success">
			✓ Models run locally — no internet required for transcription
		</div>
	{/if}
</div>
