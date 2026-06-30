<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		confidence: number;
		showIndicator?: boolean;
	}

	let { confidence, showIndicator = true }: Props = $props();

	const colorClass = $derived(
		confidence >= 0.8
			? 'bg-success'
			: confidence >= 0.7
				? 'bg-warning'
				: confidence >= 0.4
					? 'bg-warning'
					: 'bg-destructive'
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
		<div
			class={cn('size-2 rounded-full transition-colors duration-200', colorClass)}
			role="status"
		></div>
	</div>
{/if}
