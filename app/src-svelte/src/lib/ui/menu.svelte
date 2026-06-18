<script lang="ts">
	import { Menu } from '@ark-ui/svelte/menu';
	import { Portal } from '@ark-ui/svelte/portal';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	export interface MenuItem {
		value: string;
		label: string;
		disabled?: boolean;
		destructive?: boolean;
	}

	interface Props {
		items: MenuItem[];
		trigger: Snippet;
		onSelect?: (value: string) => void;
		class?: string;
	}

	let { items, trigger, onSelect, class: className }: Props = $props();
</script>

<Menu.Root onSelect={(details) => onSelect?.(details.value)}>
	<Menu.Trigger class="inline-flex" tabindex={-1}>{@render trigger()}</Menu.Trigger>
	<Portal>
		<Menu.Positioner>
			<Menu.Content
				class={cn(
					'z-50 max-h-72 min-w-40 overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md focus:outline-none',
					className
				)}
			>
				{#each items as item (item.value)}
					<Menu.Item
						value={item.value}
						disabled={item.disabled}
						class={cn(
							'relative flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-secondary data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
							item.destructive && 'text-destructive data-[highlighted]:bg-destructive/10'
						)}
					>
						{item.label}
					</Menu.Item>
				{/each}
			</Menu.Content>
		</Menu.Positioner>
	</Portal>
</Menu.Root>
