<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils/cn';

	let {
		id,
		class: className,
		children
	}: { id?: string; class?: string; children: Snippet } = $props();
</script>

<section {id} class={cn('mx-auto w-full max-w-6xl px-6', className)}>
	{@render children()}
</section>
