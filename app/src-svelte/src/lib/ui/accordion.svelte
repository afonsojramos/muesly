<script lang="ts">
	import { Accordion } from '@ark-ui/svelte/accordion';
	import { ChevronDown } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		/** Section heading. */
		title: string;
		value?: string;
		class?: string;
		children: Snippet;
	}

	let { title, value = 'item', class: className, children }: Props = $props();
</script>

<Accordion.Root collapsible class={cn('w-full', className)}>
	<Accordion.Item {value}>
		<Accordion.ItemTrigger
			class="flex w-full items-center justify-between py-2 text-left font-medium transition-colors hover:text-foreground"
		>
			{title}
			<Accordion.ItemIndicator class="transition-transform data-[state=open]:rotate-180">
				<ChevronDown class="size-4" />
			</Accordion.ItemIndicator>
		</Accordion.ItemTrigger>
		<Accordion.ItemContent>
			{@render children()}
		</Accordion.ItemContent>
	</Accordion.Item>
</Accordion.Root>
