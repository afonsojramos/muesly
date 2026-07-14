<script lang="ts">
	import type { Snippet } from 'svelte';
	import { mergeProps } from 'bits-ui';

	import { Button, type ButtonProps } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { cn } from '$lib/utils';

	interface Props {
		children: Snippet;
		tooltip: string;
		ariaLabel?: string;
		shortcut?: string;
		disabled?: boolean;
		pressed?: boolean;
		overlayOpen?: boolean;
		onclick?: ButtonProps['onclick'];
		/** Props supplied by a Popover/Dialog trigger. */
		triggerProps?: Record<string, unknown>;
		class?: string;
	}

	let {
		children,
		tooltip,
		ariaLabel = tooltip,
		shortcut,
		disabled = false,
		pressed,
		overlayOpen = false,
		onclick,
		triggerProps = {},
		class: className,
	}: Props = $props();

	let tooltipOpen = $state(false);
	let suppressTooltip = $state(false);
	$effect(() => {
		if (overlayOpen) suppressTooltip = true;
	});
	$effect(() => {
		if (tooltipOpen && (overlayOpen || suppressTooltip)) tooltipOpen = false;
	});
</script>

<Tooltip.Provider>
	<Tooltip.Root bind:open={tooltipOpen}>
		<Tooltip.Trigger>
			{#snippet child({ props: tooltipProps })}
				<Button
					{...mergeProps(tooltipProps, triggerProps, {
						onclick,
						onpointerenter: () => (suppressTooltip = false),
					})}
					variant="ghost"
					size="icon"
					class={cn('group shrink-0 rounded-full text-muted-foreground', className)}
					{disabled}
					aria-label={ariaLabel}
					aria-pressed={pressed}
				>
					{@render children()}
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			{tooltip}
			{#if shortcut}<span class="ml-1.5 tracking-wide opacity-60">{shortcut}</span>{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
