<script lang="ts">
	import { fade } from 'svelte/transition';
	import { Upload } from '@lucide/svelte';
	import { getAudioFormatsDisplayList } from '$lib/constants/audio-formats';
	import { cn } from '$lib/utils';

	interface Props {
		visible: boolean;
	}

	let { visible }: Props = $props();
</script>

{#if visible}
	<div
		class={cn(
			'pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm'
		)}
		transition:fade={{ duration: 200 }}
	>
		<div
			class={cn(
				'scale-100 rounded-2xl border-2 border-dashed border-accent bg-accent/15 p-12 text-center shadow-2xl'
			)}
		>
			<Upload class="mx-auto mb-4 size-16 text-accent" />
			<p class="text-xl font-medium text-white">Drop audio file to import</p>
			<p class="mt-2 text-sm text-white/80">{getAudioFormatsDisplayList()}</p>
		</div>
	</div>
{/if}
