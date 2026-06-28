<script lang="ts">
	import '../app.css';
	import { onMount, type Snippet } from 'svelte';
	import { theme } from '$lib/stores/theme.svelte';

	const { children }: { children: Snippet } = $props();

	// Apply the warm-paper theme class to <html> so every route (including the
	// isolated /pill window) renders the right tokens, dark mode included. This is
	// the only side effect the root layout owns; bootStores and the rest of the app
	// shell live in (app)/+layout.svelte so the pill route stays minimal.
	// theme.init() is idempotent, so the (app) layout calling it again is harmless.
	onMount(() => {
		theme.init();
	});
</script>

{@render children()}
