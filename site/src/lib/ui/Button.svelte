<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLAnchorAttributes, HTMLButtonAttributes } from 'svelte/elements';
	import { buttonVariants, type ButtonSize, type ButtonVariant } from './button-variants';

	// Renders an <a> when `href` is set, a <button> otherwise. Intersection of
	// both attribute sets keeps `{...rest}` spreadable onto either element.
	type Props = Omit<HTMLButtonAttributes, 'class'> &
		Omit<HTMLAnchorAttributes, 'class'> & {
			variant?: ButtonVariant;
			size?: ButtonSize;
			class?: string;
			children: Snippet;
		};

	let {
		variant = 'default',
		size = 'default',
		class: className,
		href,
		children,
		...rest
	}: Props = $props();
</script>

{#if href}
	<a {href} class={buttonVariants({ variant, size, class: className })} {...rest}>
		{@render children()}
	</a>
{:else}
	<button class={buttonVariants({ variant, size, class: className })} {...rest}>
		{@render children()}
	</button>
{/if}
