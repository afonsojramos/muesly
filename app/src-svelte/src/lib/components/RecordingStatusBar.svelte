<script lang="ts">
	import { fly } from 'svelte/transition';
	import { recordingState } from '$lib/stores/recording-state.svelte';

	interface Props {
		isPaused?: boolean;
	}

	let { isPaused = false }: Props = $props();

	const displaySeconds = $derived(
		recordingState.activeDuration !== null ? Math.floor(recordingState.activeDuration) : 0
	);

	function formatDuration(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}
</script>

<div
	transition:fly={{ y: -10, duration: 200 }}
	class="mb-2 flex items-center gap-2 rounded-lg bg-secondary px-3 py-2"
>
	<div
		class={`size-2 rounded-full ${isPaused ? 'bg-muted-foreground/60' : 'animate-pulse bg-accent'}`}
	></div>
	<span class={`text-sm tabular-nums ${isPaused ? 'text-muted-foreground' : 'text-foreground'}`}>
		{isPaused ? 'Paused' : 'Recording'} • {formatDuration(displaySeconds)}
	</span>
</div>
