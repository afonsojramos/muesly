<script lang="ts">
	import { cn } from '$lib/utils';

	interface Props {
		class?: string;
		orientation?: 'horizontal' | 'vertical';
	}

	let { class: className, orientation = 'horizontal' }: Props = $props();
</script>

<hr
	aria-orientation={orientation}
	class={cn(
		'shrink-0 border-0 bg-border',
		orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
		className
	)}
/>
