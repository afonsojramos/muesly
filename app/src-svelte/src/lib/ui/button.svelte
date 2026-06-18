<script lang="ts" module>
	import { cva, type VariantProps } from 'class-variance-authority';

	export const buttonVariants = cva(
		'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
		{
			variants: {
				variant: {
					default: 'bg-primary text-primary-foreground hover:bg-primary/90',
					accent: 'bg-accent text-accent-foreground hover:opacity-90',
					destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
					outline:
						'border border-input bg-background hover:bg-secondary hover:text-secondary-foreground',
					secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
					ghost: 'hover:bg-secondary hover:text-secondary-foreground',
					link: 'text-primary underline-offset-4 hover:underline'
				},
				size: {
					default: 'h-9 px-4 py-2',
					sm: 'h-8 rounded-md px-3 text-xs',
					lg: 'h-10 rounded-md px-8',
					icon: 'size-9'
				}
			},
			defaultVariants: {
				variant: 'default',
				size: 'default'
			}
		}
	);

	export type ButtonVariant = VariantProps<typeof buttonVariants>['variant'];
	export type ButtonSize = VariantProps<typeof buttonVariants>['size'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import { cn } from '$lib/utils';
	import Tooltip from './tooltip.svelte';

	interface Props extends HTMLButtonAttributes {
		variant?: ButtonVariant;
		size?: ButtonSize;
		class?: string;
		/** Optional tooltip label shown on hover (dark bubble). */
		tooltip?: string;
		/** Keyboard shortcut hint rendered after the tooltip label (e.g. "⌘S"). */
		shortcut?: string;
		children: Snippet;
	}

	let {
		variant = 'default',
		size = 'default',
		class: className,
		type = 'button',
		tooltip,
		shortcut,
		children,
		...rest
	}: Props = $props();
</script>

{#snippet btn()}
	<button {type} class={cn(buttonVariants({ variant, size }), className)} {...rest}>
		{@render children()}
	</button>
{/snippet}

{#if tooltip}
	<Tooltip label={tooltip} {shortcut}>
		{#snippet trigger()}{@render btn()}{/snippet}
	</Tooltip>
{:else}
	{@render btn()}
{/if}
