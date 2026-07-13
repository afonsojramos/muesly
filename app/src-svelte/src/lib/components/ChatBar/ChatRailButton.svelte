<script lang="ts">
	import type { Snippet } from 'svelte';
	import { mergeProps } from 'bits-ui';

	import { Button, type ButtonProps } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

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
					class="group shrink-0 rounded-full text-muted-foreground"
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
