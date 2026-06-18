<script lang="ts">
	interface Props {
		confidence: number;
		showIndicator?: boolean;
	}

	let { confidence, showIndicator = true }: Props = $props();

	const colorClass = $derived(
		confidence >= 0.8
			? 'bg-green-500'
			: confidence >= 0.7
				? 'bg-yellow-500'
				: confidence >= 0.4
					? 'bg-orange-500'
					: 'bg-red-500'
	);

	const label = $derived(
		confidence >= 0.8
			? 'High confidence'
			: confidence >= 0.7
				? 'Good confidence'
				: confidence >= 0.4
					? 'Medium confidence'
					: 'Low confidence'
	);

	const percent = $derived((confidence * 100).toFixed(0));
</script>

{#if showIndicator}
	<div
		class="flex items-center gap-1"
		title={`${percent}% confidence - ${label}`}
		aria-label={`Transcription confidence: ${percent}%`}
	>
		<div class={`size-2 rounded-full ${colorClass} transition-colors duration-200`} role="status"></div>
	</div>
{/if}
