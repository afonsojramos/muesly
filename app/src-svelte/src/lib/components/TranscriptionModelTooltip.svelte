<script lang="ts">
	import AudioLinesIcon from '@lucide/svelte/icons/audio-lines';

	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { whisperDisplayName } from '$lib/components/WhisperModelManager.svelte';

	interface Props {
		/** Technical model id, e.g. "small-q5_1". */
		model: string;
		/** Why this model was chosen (from the backend resolution). */
		reason?: string;
	}

	let { model, reason }: Props = $props();
	const displayName = $derived(whisperDisplayName(model));
</script>

<Tooltip.Provider>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="sm"
					class="h-10 px-1.5 text-muted-foreground hover:bg-transparent hover:text-foreground"
					aria-label={`Transcribed with ${displayName}`}
				>
					<AudioLinesIcon data-icon="inline-start" />
					{displayName}
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content
			side="bottom"
			sideOffset={8}
			arrowClasses="hidden"
			class="block max-w-72 px-3 py-2"
		>
			<p class="font-medium">Transcribed with {displayName}</p>
			<p class="text-primary-foreground/70">{model}</p>
			{#if reason}
				<p class="mt-1 text-primary-foreground/70">{reason}</p>
			{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
