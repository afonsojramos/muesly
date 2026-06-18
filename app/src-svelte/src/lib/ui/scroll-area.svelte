<script lang="ts">
	import { ScrollArea } from '@ark-ui/svelte/scroll-area';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		class?: string;
		viewportClass?: string;
		children: Snippet;
	}

	let { class: className, viewportClass, children }: Props = $props();
</script>

<ScrollArea.Root class={cn('relative overflow-hidden', className)}>
	<ScrollArea.Viewport class={cn('size-full rounded-[inherit]', viewportClass)}>
		<ScrollArea.Content>
			{@render children()}
		</ScrollArea.Content>
	</ScrollArea.Viewport>
	<ScrollArea.Scrollbar
		orientation="vertical"
		class="flex touch-none select-none rounded-full bg-transparent p-0.5 transition-colors hover:bg-secondary"
	>
		<ScrollArea.Thumb class="flex-1 rounded-full bg-border" />
	</ScrollArea.Scrollbar>
	<ScrollArea.Corner />
</ScrollArea.Root>
