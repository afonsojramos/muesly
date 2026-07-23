<script lang="ts">
	import type { ComponentProps, Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';

	import { cn } from '$lib/utils';
	import { Button, type ButtonSize, type ButtonVariant } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	type ButtonOnClick = ComponentProps<typeof Button>['onclick'];

	/**
	 * Icon-only button with a built-in tooltip. Every icon-only control must
	 * name its action visibly (AGENTS.md); `label` drives both the tooltip and
	 * the aria-label, so the two can never drift apart. Use for any button whose
	 * only visible content is an icon.
	 */
	interface Props {
		/** Action name shown in the tooltip and announced as the aria-label. */
		label: string;
		/** Optional keyboard shortcut shown dimmed in the tooltip (e.g. "⌘K"). */
		kbd?: string;
		onclick?: ButtonOnClick;
		variant?: ButtonVariant;
		size?: ButtonSize;
		disabled?: boolean;
		class?: string;
		type?: HTMLButtonAttributes['type'];
		'aria-pressed'?: HTMLButtonAttributes['aria-pressed'];
		children: Snippet;
	}

	let {
		label,
		kbd,
		onclick,
		variant = 'ghost',
		size = 'icon-sm',
		disabled = false,
		class: className,
		type = 'button',
		'aria-pressed': ariaPressed,
		children,
	}: Props = $props();
</script>

<Tooltip.Provider delayDuration={300}>
	<Tooltip.Root>
		<Tooltip.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					{variant}
					{size}
					{disabled}
					{type}
					aria-label={label}
					aria-pressed={ariaPressed}
					{onclick}
					class={cn(className)}
				>
					{@render children()}
				</Button>
			{/snippet}
		</Tooltip.Trigger>
		<Tooltip.Content>
			{label}
			{#if kbd}
				<span class="tracking-wide opacity-60">{kbd}</span>
			{/if}
		</Tooltip.Content>
	</Tooltip.Root>
</Tooltip.Provider>
