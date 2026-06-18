<script lang="ts">
	import type { Snippet } from 'svelte';
	import { sidebar } from '$lib/stores/sidebar.svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<!-- min-w-0: as a flex child, <main> defaults to min-width:auto, which is its
     content's min-content (driven by the meeting view's fixed-width side panel).
     Without this it refuses to shrink below that, overflowing the window on
     narrow sizes and dragging the side panel past the right edge. -->
<main
	class={`min-w-0 flex-1 ${sidebar.isResizing ? '' : 'transition-[margin] duration-300'}`}
	style={`margin-left: ${sidebar.effectiveWidth}px`}
>
	{@render children()}
</main>
