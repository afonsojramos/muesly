<script lang="ts" module>
	import { cva, type VariantProps } from 'class-variance-authority';

	export const alertVariants = cva(
		'relative w-full rounded-lg border px-4 py-3 text-sm [&>svg]:absolute [&>svg]:left-4 [&>svg]:top-4 [&>svg]:text-foreground [&>svg~*]:pl-7',
		{
			variants: {
				variant: {
					default: 'bg-background text-foreground',
					destructive:
						'border-destructive/50 text-destructive [&>svg]:text-destructive bg-destructive/5',
					warning: 'border-warning/50 text-warning bg-warning/10 [&>svg]:text-warning'
				}
			},
			defaultVariants: { variant: 'default' }
		}
	);

	export type AlertVariant = VariantProps<typeof alertVariants>['variant'];
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	interface Props {
		variant?: AlertVariant;
		class?: string;
		icon?: Snippet;
		title?: Snippet;
		children: Snippet;
	}

	let { variant = 'default', class: className, icon, title, children }: Props = $props();
</script>

<div role="alert" class={cn(alertVariants({ variant }), className)}>
	{@render icon?.()}
	{#if title}
		<h5 class="mb-1 font-medium leading-none tracking-tight">{@render title()}</h5>
	{/if}
	<div class="text-sm [&_p]:leading-relaxed">{@render children()}</div>
</div>
