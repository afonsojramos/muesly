<script lang="ts">
	import { Popover } from '@ark-ui/svelte/popover';
	import { Portal } from '@ark-ui/svelte/portal';
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		open?: boolean;
		onOpenChange?: (open: boolean) => void;
		trigger: Snippet;
		children: Snippet;
		class?: string;
		placement?: 'top' | 'bottom' | 'left' | 'right' | 'bottom-start' | 'bottom-end';
	}

	let {
		open = $bindable(false),
		onOpenChange,
		trigger,
		children,
		class: className,
		placement = 'bottom-start'
	}: Props = $props();
</script>

<Popover.Root
	open={open}
	positioning={{ placement }}
	onOpenChange={(details) => {
		open = details.open;
		onOpenChange?.(details.open);
	}}
>
	<Popover.Trigger class="inline-flex">{@render trigger()}</Popover.Trigger>
	<Portal>
		<Popover.Positioner>
			<Popover.Content
				class={cn(
					'z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md focus:outline-none',
					className
				)}
			>
				{@render children()}
			</Popover.Content>
		</Popover.Positioner>
	</Portal>
</Popover.Root>
