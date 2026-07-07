<script lang="ts">
	import type { Snippet } from 'svelte';
	import { cn } from '$lib/utils';

	// Keeps the layout stable while data loads: instead of swapping the content for
	// a skeleton (which reflows), render it and disable every control inside until
	// `loading` clears. A native `fieldset[disabled]` cascades to nested
	// buttons/inputs — the shadcn Switches included, which then pick up their
	// `:disabled` styling — and `display: contents` keeps the fieldset itself out of
	// the layout so children flow exactly as if it weren't there.
	let {
		loading = false,
		class: className,
		children,
	}: {
		loading?: boolean;
		class?: string;
		children: Snippet;
	} = $props();
</script>

<fieldset disabled={loading} aria-busy={loading} class={cn('contents', className)}>
	{@render children()}
</fieldset>
