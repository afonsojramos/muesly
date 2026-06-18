<script lang="ts">
	import { scale } from 'svelte/transition';
	import { FileQuestion, Sparkles } from '@lucide/svelte';
	import Button from '$lib/ui/button.svelte';
	import Tooltip from '$lib/ui/tooltip.svelte';

	interface Props {
		onGenerate: () => void;
		hasModel: boolean;
		isGenerating?: boolean;
	}

	let { onGenerate, hasModel, isGenerating = false }: Props = $props();
</script>

<div
	in:scale={{ start: 0.95, duration: 300 }}
	class="flex h-full flex-col items-center justify-center p-8 text-center"
>
	<FileQuestion class="mb-4 size-16 text-muted-foreground/40" />
	<h3 class="mb-2 font-display text-2xl text-foreground/90">No notes yet</h3>
	<p class="mb-6 max-w-md text-sm text-muted-foreground">
		Enhance your meeting transcript into structured notes with key points, action items, and
		decisions.
	</p>

	{#if hasModel}
		<Button variant="accent" onclick={onGenerate} disabled={isGenerating}>
			<Sparkles class="size-4" />
			{isGenerating ? 'Enhancing...' : 'Enhance notes'}
		</Button>
	{:else}
		<Tooltip>
			{#snippet trigger()}
				<Button disabled>
					<Sparkles class="size-4" />
					Enhance notes
				</Button>
			{/snippet}
			{#snippet content()}
				Please select a model in Settings first
			{/snippet}
		</Tooltip>
		<p class="mt-3 text-xs text-amber-600">Please select a model in Settings first</p>
	{/if}
</div>
