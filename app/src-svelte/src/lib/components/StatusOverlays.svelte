<script lang="ts">
	import { fade } from 'svelte/transition';

	import { sidebar } from '$lib/stores/sidebar.svelte';

	interface Props {
		/** Processing transcription after recording stops. */
		isProcessing: boolean;
		/** Saving transcript to the database. */
		isSaving: boolean;
	}

	let { isProcessing, isSaving }: Props = $props();

	const overlays = $derived(
		[
			{ show: isProcessing, message: 'Finalizing transcription...' },
			{ show: isSaving, message: 'Saving transcript...' },
		].filter((o) => o.show),
	);
</script>

{#each overlays as overlay (overlay.message)}
	<div
		class="fixed bottom-4 left-0 right-0 z-10"
		role="status"
		aria-live="polite"
		transition:fade={{ duration: 150 }}
	>
		<div
			class="flex justify-center transition-[margin] duration-300"
			style={`margin-left: ${sidebar.effectiveWidth}px`}
		>
			<div class="flex w-2/3 max-w-[750px] justify-center">
				<div class="flex items-center gap-2 rounded-lg bg-card px-4 py-2 shadow-lg">
					<div class="size-4 animate-spin rounded-full border-b-2 border-foreground"></div>
					<span class="text-sm text-foreground">{overlay.message}</span>
				</div>
			</div>
		</div>
	</div>
{/each}
