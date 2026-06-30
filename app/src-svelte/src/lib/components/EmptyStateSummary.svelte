<script lang="ts">
	import { scale } from 'svelte/transition';
	import { FileQuestion, Sparkles } from '@lucide/svelte';
	import { Button } from '$lib/components/ui/button';
	import AccentButton from '$lib/ui/button.svelte';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
		<AccentButton variant="accent" onclick={onGenerate} disabled={isGenerating}>
			<Sparkles data-icon="inline-start" />
			{isGenerating ? 'Enhancing...' : 'Enhance notes'}
		</AccentButton>
	{:else}
		<Tooltip.Provider delayDuration={300}>
			<Tooltip.Root>
				<Tooltip.Trigger>
					{#snippet child({ props })}
						<Button {...props} disabled>
							<Sparkles data-icon="inline-start" />
							Enhance notes
						</Button>
					{/snippet}
				</Tooltip.Trigger>
				<Tooltip.Content>Please select a model in Settings first</Tooltip.Content>
			</Tooltip.Root>
		</Tooltip.Provider>
		<p class="mt-3 text-xs text-warning">Please select a model in Settings first</p>
	{/if}
</div>
