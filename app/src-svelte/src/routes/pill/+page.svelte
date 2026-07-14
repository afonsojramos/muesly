<script lang="ts">
	import { onMount } from 'svelte';
	import RecordingPill from '$lib/components/RecordingPill.svelte';

	// The OS window is transparent, but the DOM still paints html/body backgrounds
	// (app.css sets an opaque body). Mark this route so the document is transparent
	// and the rounded pill is the only visible chrome.
	onMount(() => {
		document.documentElement.classList.add('pill-route');
		return () => document.documentElement.classList.remove('pill-route');
	});
</script>

<RecordingPill showControls={false} />

<style>
	:global(html.pill-route),
	:global(html.pill-route body) {
		background: transparent !important;
	}
</style>
