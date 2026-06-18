<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let { class: className, children }: { class?: string; children: Snippet } = $props();
</script>

<span
	class={cn(
		'inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-sm font-medium text-foreground',
		className
	)}
>
	{@render children()}
</span>
